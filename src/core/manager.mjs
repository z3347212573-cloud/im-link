import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stateStore, record, validateChannel, publicChannel } from './model.mjs';
import { ConfigTransaction, hash, readJson } from './files.mjs';
import { Vault } from './vault.mjs';
import { discover, legacyCredentials, nodeExecutable, inspectProfile } from './discovery.mjs';
import { configureProfile } from './registration.mjs';
import { checkFeishuCredentials } from '../adapters/feishu.mjs';
import { sessionSnapshot } from './transitions.mjs';

export class Manager {
  constructor(root, options = {}) {
    this.root = root;
    this.store = stateStore(root);
    this.vault = options.vault || new Vault(root);
    this.appRoot = options.appRoot || fileURLToPath(new URL('../../', import.meta.url));
    this.home = options.home;
    this.node = options.node;
    this.findings = [];
    this.scanErrors = [];
  }
  async scan() {
    const found = await discover(this.home);
    this.findings = found.findings;
    this.scanErrors = found.errors;
    await this.store.update((state) => {
      for (const profile of found.profiles) {
        const old = state.profiles.find((item) => item.id === profile.id);
        if (old) Object.assign(old, profile, { label: old.label });
        else state.profiles.push(profile);
      }
    });
    return this.snapshot();
  }
  async snapshot() {
    const state = await this.store.read();
    const channels = await Promise.all(state.channels.map(async (channel) => {
      const runtime = await readJson(path.join(this.root, 'runtime', channel.id + '.json'), null);
      return publicChannel(channel, runtime?.revision === channel.revision ? runtime : null);
    }));
    const profiles = await Promise.all(state.profiles.map(inspectProfile));
    return { ...state, profiles, channels, findings: this.findings, scanErrors: this.scanErrors, dataPath: this.root, platform: process.platform, version: '0.1.0' };
  }
  async addProfile(input) {
    if (!['dsh', 'claude'].includes(input.agent) || !path.isAbsolute(input.root)) throw new Error('请选择 Agent 类型和有效的配置文件夹。');
    if (!await fs.stat(input.root).catch(() => null)) throw new Error('配置文件夹不存在。');
    const id = input.agent + '-' + hash(path.resolve(input.root)).slice(0, 16);
    await this.store.update((state) => {
      if (state.profiles.some((profile) => profile.id === id)) throw new Error('这套设置已存在。');
      state.profiles.push({
        id, agent: input.agent, label: String(input.label || '自定义设置').slice(0, 80),
        root: input.root, configPath: path.join(input.root, input.agent === 'dsh' ? 'cordis.patch.yml' : 'settings.json'),
        installed: true, source: 'manual', note: '独立设置，需通过原有入口加载这套配置。',
      });
      record(state, '添加设置', '已添加一套独立 Agent 设置。');
    });
    return this.snapshot();
  }
  async save(input) {
    const fields = validateChannel(input);
    if (fields.cwd && !(await fs.stat(fields.cwd).catch(() => null))?.isDirectory()) throw new Error('所选工作文件夹不存在。');
    const state = await this.store.read();
    const fingerprint = hash(fields.appId);
    if (state.channels.some((item) => item.fingerprint === fingerprint)) throw new Error('这个飞书机器人已经添加，请直接修改或更换绑定。');
    const id = randomUUID();
    await this.vault.put(id, { appId: fields.appId, appSecret: fields.appSecret });
    try {
      await this.store.update((value) => {
        if (value.channels.some((item) => item.fingerprint === fingerprint)) throw new Error('这个机器人已经添加。');
        value.channels.push({
          id, name: fields.name, kind: 'feishu', fingerprint,
          appIdHint: fields.appId.slice(0, 7) + '…' + fields.appId.slice(-4),
          cwd: fields.cwd, binding: null, revision: 0, status: 'unbound',
          createdAt: new Date().toISOString(), verifiedAt: null,
        });
        record(value, '添加渠道', '已保存“' + fields.name + '”的接入信息。', id);
      });
      if (input.profileId) await this.bind(id, input.profileId);
    } catch (error) {
      const existing = (await this.store.read()).channels.find((item) => item.id === id);
      if (!existing?.binding) {
        await this.store.update((value) => { value.channels = value.channels.filter((item) => item.id !== id); });
        await this.vault.remove(id);
      }
      throw error;
    }
    return this.snapshot();
  }
  async bind(id, profileId, imported = null) {
    const state = await this.store.read();
    const channel = state.channels.find((item) => item.id === id);
    const profile = state.profiles.find((item) => item.id === profileId);
    if (!channel || !profile) throw new Error('渠道或目标 Agent 设置不存在。');
    if (channel.pending) throw new Error('这个渠道还有未完成的更换操作。');
    if (channel.binding === profileId) return this.snapshot();
    await this.vault.get(id);
    const transaction = new ConfigTransaction(path.join(this.root, 'backups'));
    try {
      await configureProfile({
        profile, root: this.root, appRoot: this.appRoot, node: this.node || await nodeExecutable(), transaction,
        disablePluginId: imported?.pluginId,
      });
      const runtime = await readJson(path.join(this.root, 'runtime', id + '.json'), null);
      const active = runtime && Date.now() - runtime.heartbeat < 15000 && runtime.revision === channel.revision;
      const sessions = active ? null : await sessionSnapshot(this.root, id);
      await this.store.update((value) => {
        const current = value.channels.find((item) => item.id === id);
        if (current.binding !== channel.binding || current.pending) throw new Error('渠道状态已变化，请刷新后重试。');
        if (active) {
          current.pending = { profileId, requestedAt: Date.now(), backupId: transaction.id };
          current.status = 'waiting_tasks';
        } else {
          current.transition = { previousBinding: current.binding, backupId: transaction.id, sessions };
          current.binding = profileId;
          current.revision++;
          current.status = 'waiting_restart';
          current.verifiedAt = null;
        }
        current.backupId = transaction.id;
        current.recoveryNote = null;
        record(value, '配置绑定', '已为“' + current.name + '”配置 ' + (profile.agent === 'dsh' ? 'DSH' : 'Claude Code') + '；需验证新会话生效。', id);
      });
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    return this.snapshot();
  }
  async updateChannel(id, input) {
    if (input.cwd && !path.isAbsolute(input.cwd)) throw new Error('工作文件夹需要是绝对路径。');
    if (input.cwd && !(await fs.stat(input.cwd).catch(() => null))?.isDirectory()) throw new Error('工作文件夹不存在。');
    let oldCredentials;
    try {
    await this.store.update(async (state) => {
      const channel = state.channels.find((item) => item.id === id);
      if (!channel) throw new Error('渠道不存在。');
      if (String(input.appId || '').trim() || String(input.appSecret || '').trim()) {
        if (channel.binding || channel.pending) throw new Error('请先解绑，再更新机器人接入信息。');
        oldCredentials = await this.vault.get(id);
        const credentials = validateChannel({
          name: input.name ?? channel.name, cwd: input.cwd ?? channel.cwd,
          appId: String(input.appId || '').trim() || oldCredentials.appId,
          appSecret: String(input.appSecret || '').trim() || oldCredentials.appSecret,
        });
        const fingerprint = hash(credentials.appId);
        if (state.channels.some((item) => item.id !== id && item.fingerprint === fingerprint)) throw new Error('这个机器人已经添加。');
        await this.vault.put(id, { appId: credentials.appId, appSecret: credentials.appSecret });
        channel.fingerprint = fingerprint;
        channel.appIdHint = credentials.appId.slice(0, 7) + '…' + credentials.appId.slice(-4);
        channel.credentialsCheckedAt = null; channel.verifiedAt = null;
      }
      if (input.name !== undefined) {
        if (!String(input.name).trim()) throw new Error('渠道名称不能为空。');
        channel.name = String(input.name).trim().slice(0, 80);
      }
      if (input.cwd !== undefined) channel.cwd = input.cwd;
      record(state, '更新渠道', '已更新渠道设置；工作文件夹更改在渠道组件重开后生效。', id);
    });
    } catch (error) { if (oldCredentials) await this.vault.put(id, oldCredentials); throw error; }
    return this.snapshot();
  }
  async unbind(id) {
    await this.store.update((state) => {
      const channel = state.channels.find((item) => item.id === id);
      if (!channel) throw new Error('渠道不存在。');
      channel.pending = { profileId: null, requestedAt: Date.now() };
      channel.status = 'waiting_tasks';
      record(state, '请求解绑', '等待正在执行的任务完成后停用接入。', id);
    });
    const runtime = await readJson(path.join(this.root, 'runtime', id + '.json'), null);
    if (!runtime || Date.now() - runtime.heartbeat > 15000) {
      await this.store.update((state) => {
        const channel = state.channels.find((item) => item.id === id);
        if (channel?.pending?.profileId === null) {
          channel.binding = null; channel.revision++; channel.pending = null;
          channel.transition = null;
          channel.status = 'unbound'; channel.verifiedAt = null;
        }
      });
    }
    return this.snapshot();
  }
  async remove(id) {
    const channel = (await this.store.read()).channels.find((item) => item.id === id);
    if (!channel) throw new Error('渠道不存在。');
    if (channel.binding || channel.pending) throw new Error('请先解绑，等待接入停用后再删除渠道。');
    await this.vault.remove(id);
    await this.store.update((state) => {
      state.channels = state.channels.filter((item) => item.id !== id);
      record(state, '删除渠道', '已删除渠道及本工具保存的凭据；原 Agent 会话记录保留。', id);
    });
    return this.snapshot();
  }
  async check(id) {
    const result = await checkFeishuCredentials(await this.vault.get(id));
    await this.store.update((state) => {
      const channel = state.channels.find((item) => item.id === id);
      if (!channel) throw new Error('渠道不存在。');
      channel.credentialsCheckedAt = result.checkedAt;
      record(state, '校验凭据', '接入信息有效；尚未证明双向通信。', id);
    });
    return { ...result, snapshot: await this.snapshot() };
  }
  async importFinding(id) {
    const finding = this.findings.find((item) => item.id === id);
    if (!finding) throw new Error('发现结果已变化，请重新扫描。');
    const credentials = await legacyCredentials(finding);
    const snapshot = await this.save({ ...credentials, name: finding.name, cwd: finding.cwd });
    const channel = snapshot.channels.find((item) => item.fingerprint === hash(credentials.appId));
    try {
      await this.bind(channel.id, finding.profileId, finding);
      await this.store.update((value) => { value.channels.find((item) => item.id === channel.id).importedFrom = finding.id; });
      return this.snapshot();
    }
    catch (error) { await this.remove(channel.id); throw error; }
  }
}
