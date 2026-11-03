import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JsonStore, atomicWrite, readJson, alive, hash } from '../core/files.mjs';
import { stateStore, record } from '../core/model.mjs';
import { Vault } from '../core/vault.mjs';
import { Conversations, conversationFile } from '../core/conversations.mjs';
import { Feishu } from '../adapters/feishu.mjs';
import { restoreTransition, sessionSnapshot } from '../core/transitions.mjs';
import { ImageStore } from '../core/media.mjs';

export class AgentHost {
  constructor(root, profileId, driverFactory, options = {}) {
    Object.assign(this, { root, profileId, driverFactory });
    this.store = stateStore(root);
    this.vault = options.vault || new Vault(root);
    this.transportFactory = options.transportFactory || ((credentials) => new Feishu(credentials));
    this.channels = new Map();
    this.closed = false;
    this.ticking = false;
  }
  async start() {
    await fs.mkdir(path.join(this.root, 'runtime'), { recursive: true });
    await this.tick();
    if (!this.closed) this.timer = setInterval(() => this.tick().catch(() => {}), 1500);
    return this;
  }
  async tick() {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      const state = await this.store.read();
      const profile = state.profiles.find((item) => item.id === this.profileId);
      if (!profile || this.closed) return;
      for (const [id, runtime] of this.channels) {
        const channel = state.channels.find((item) => item.id === id);
        if (runtime.failed && runtime.engine?.busy === 0 && channel?.transition) {
          await this.closeChannel(id);
          await restoreTransition(this.root, id, runtime.revision);
          continue;
        }
        if (channel?.pending && runtime.engine.busy === 0) {
          const sessions = await sessionSnapshot(this.root, id);
          await this.store.update((value) => {
            const current = value.channels.find((item) => item.id === id);
            if (current?.pending) {
              current.transition = current.pending.profileId ? {
                previousBinding: current.binding, backupId: current.pending.backupId, sessions
              } : null;
              current.binding = current.pending.profileId;
              current.pending = null; current.revision++;
              current.status = current.binding ? 'waiting_restart' : 'unbound';
              current.verifiedAt = null;
              record(value, '任务结束', '已完成等待操作，接入所有权正在转交。', id);
            }
          });
          await this.closeChannel(id);
          continue;
        }
        if (!channel || channel.binding !== this.profileId || channel.revision !== runtime.revision) {
          if (runtime.engine.busy === 0) await this.closeChannel(id);
          continue;
        }
        await this.heartbeat(id, runtime);
        const conversations = await runtime.engine.store.read();
        for (const chatId of Object.keys(conversations.chats || {})) runtime.engine.pump(chatId);
      }
      const latest = await this.store.read();
      for (const channel of latest.channels) {
        if (this.closed) break;
        if (channel.binding === this.profileId && !channel.pending && !this.channels.has(channel.id)) await this.openChannel(channel, profile);
      }
    } finally { this.ticking = false; }
  }
  async openChannel(channel, profile) {
    const lock = path.join(this.root, 'runtime', channel.id + '.owner');
    const token = randomUUID();
    try {
      const handle = await fs.open(lock, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      await handle.close();
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await readJson(lock, null);
      if (owner && !alive(owner.pid)) await fs.rm(lock, { force: true });
      return;
    }
    const runtime = { token, lock, revision: channel.revision, busy: 0, status: 'starting' };
    this.channels.set(channel.id, runtime);
    try {
      const credentials = await this.vault.get(channel.id);
      if (this.closed || runtime.closed) throw new Error('closed');
      const transport = this.transportFactory(credentials);
      runtime.transport = transport;
      const driver = await this.driverFactory(profile, channel.cwd);
      const media = new ImageStore(path.join(this.root, 'media', hash(channel.id)), channel.cwd);
      if (this.closed || runtime.closed) { await driver.close?.(); throw new Error('closed'); }
      const engine = new Conversations({
        store: new JsonStore(conversationFile(this.root, channel.id), { chats: {}, seen: [] }),
        driver, revision: channel.revision,
        prepareInput: (job) => media.input(job, transport),
        prepareResult: (result, id) => media.output(result, id),
        cleanup: (id) => media.cleanup(id),
        canStart: async () => {
          const current = (await this.store.read()).channels.find((item) => item.id === channel.id);
          return runtime.ready === true && !(runtime.failed && current?.transition) && !!current && current.binding === this.profileId && !current.pending && current.revision === channel.revision;
        },
        send: async (chatId, text, messageId) => {
          try { await transport.send(chatId, text, messageId); }
          catch (error) {
            runtime.status = 'error';
            runtime.lastError = '回复投递失败，正在重试。请检查网络、消息发送与图片资源权限；无需重发任务。';
            await this.heartbeat(channel.id, runtime);
            throw error;
          }
          runtime.status = 'listening';
          runtime.lastError = null;
          if (messageId.startsWith('result:')) {
            await this.store.update((state) => {
              const item = state.channels.find((value) => value.id === channel.id);
              if (item?.revision === channel.revision) {
                item.verifiedAt = new Date().toISOString(); item.status = 'verified';
                item.transition = null;
                item.recoveryNote = null;
              }
            });
            runtime.lastError = null;
            runtime.failed = false;
          }
        },
        failure: () => { runtime.failed = true; runtime.lastError = 'Agent 未完成请求，请检查登录或模型配置。'; },
      });
      runtime.engine = engine;
      await engine.recover(false);
      if (this.closed || runtime.closed) throw new Error('closed');
      await transport.start(async (event) => {
        runtime.lastMessageAt = new Date().toISOString();
        await engine.ingest(event);
      });
      if (this.closed || runtime.closed) { await transport.close(); return; }
      runtime.ready = true;
      runtime.status = 'listening';
      await this.heartbeat(channel.id, runtime);
      for (const chatId of Object.keys((await engine.store.read()).chats)) engine.pump(chatId);
    } catch {
      if (this.closed || runtime.closed) return;
      runtime.status = 'error';
      runtime.lastError = '渠道组件启动失败，请检查凭据、网络、权限及 Agent 接入。';
      await this.heartbeat(channel.id, runtime);
      await this.closeChannel(channel.id);
      await restoreTransition(this.root, channel.id, channel.revision);
    }
  }
  async heartbeat(id, runtime) {
    await atomicWrite(path.join(this.root, 'runtime', id + '.json'), JSON.stringify({
      revision: runtime.revision, heartbeat: Date.now(), status: runtime.status,
      busy: runtime.engine?.busy || 0, lastError: runtime.lastError,
      lastMessageAt: runtime.lastMessageAt,
    }));
  }
  async closeChannel(id) {
    const runtime = this.channels.get(id);
    if (!runtime) return;
    this.channels.delete(id);
    runtime.closed = true;
    await runtime.engine?.stop();
    await runtime.transport?.close();
    const owner = await readJson(runtime.lock, null);
    if (owner?.token === runtime.token) await fs.rm(runtime.lock, { force: true });
    if (runtime.status !== 'error') {
      runtime.status = 'stopped';
      await this.heartbeat(id, runtime);
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const id of [...this.channels.keys()]) await this.closeChannel(id);
  }
}

async function runClaudeHost(root, profileId) {
  const file = path.join(root, 'hosts', profileId, 'host.pid');
  const { withLock } = await import('../core/files.mjs');
  let claimed = false;
  await withLock(file, async () => {
    const existing = await readJson(file, null);
    if (!existing || !alive(existing.pid)) {
      await atomicWrite(file, JSON.stringify({ pid: process.pid }));
      claimed = true;
    }
  });
  if (!claimed) return;
  const { ClaudeDriver } = await import('../adapters/claude.mjs');
  const host = new AgentHost(root, profileId, async (profile, cwd) => new ClaudeDriver(profile, cwd));
  const startup = host.start().catch(() => {});
  let emptySince = null;
  const lifetime = setInterval(async () => {
    const entries = await fs.readdir(path.dirname(file)).catch(() => []);
    let live = false;
    for (const entry of entries.filter((name) => name.endsWith('.lease.json'))) {
      const leaseFile = path.join(path.dirname(file), entry);
      const lease = await readJson(leaseFile, null);
      if (lease && alive(lease.pid)) live = true;
      else await fs.rm(leaseFile, { force: true });
    }
    if (live) emptySince = null;
    else emptySince ||= Date.now();
    if (emptySince && Date.now() - emptySince > 6000) {
      clearInterval(lifetime);
      await host.close();
      if ((await readJson(file, null))?.pid === process.pid) await fs.rm(file, { force: true });
      process.exit(0);
    }
  }, 2000);
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { clearInterval(lifetime); await host.close(); process.exit(0); });
  await startup;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2], profileId = process.argv[3];
  if (root && profileId) await runClaudeHost(root, profileId);
}
