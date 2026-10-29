import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { parseDocument } from 'yaml';
import { hash, readJson } from './files.mjs';

export async function yamlDocument(file) {
  const text = await fs.readFile(file, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '[]\n';
    throw error;
  });
  const document = parseDocument(text, { strict: false, uniqueKeys: true });
  if (document.errors.length) throw new Error('无法解析配置，已保留原文件，请先修复 YAML 格式。');
  // Unknown DSH !!js tags stay tagged scalars. Never evaluate user expressions.
  return document;
}
function rows(value, output = []) {
  if (Array.isArray(value)) for (const entry of value) rows(entry, output);
  else if (value && typeof value === 'object') {
    if (typeof value.name === 'string' && (/feishu|im-link/i.test(value.name) || String(value.id).startsWith('im-link'))) output.push(value);
    if (value.insert) rows(value.insert, output);
    if (Array.isArray(value.config)) rows(value.config, output);
  }
  return output;
}
export async function inspectProfile(profile) {
  try {
    if (profile.agent === 'claude') {
      const config = await readJson(profile.configPath, {});
      return { ...profile, extensionConfigured: ['SessionStart', 'SessionEnd'].every((event) =>
        config.hooks?.[event]?.some((row) => row.hooks?.some((hook) => Array.isArray(hook.args) && hook.args.includes('--im-link')))),
        hooksDisabled: config.disableAllHooks === true };
    }
    const entries = rows((await yamlDocument(profile.configPath)).toJS());
    return { ...profile, extensionConfigured: entries.some((row) => row.id === 'im-link-managed'),
      existingChannelPlugins: entries.filter((row) => row.id !== 'im-link-managed').map((row) => String(row.name)) };
  } catch { return { ...profile, extensionConfigured: false, inspectionError: true }; }
}
export async function discover(home = os.homedir()) {
  const profiles = [];
  const findings = [];
  const errors = [];
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const claudeConfig = path.join(claudeRoot, 'settings.json');
  const claudeExists = !!await fs.stat(claudeRoot).catch(() => null);
  profiles.push({
    id: 'claude-' + hash(claudeRoot).slice(0, 16), agent: 'claude', label: '默认设置',
    root: claudeRoot, configPath: claudeConfig, installed: claudeExists,
    source: 'discovered', note: '通过用户级生命周期钩子接入；各原有入口需逐项验证。',
  });
  const dshRoot = process.env.DSH_HOME || path.join(home, '.dsh');
  const dirs = await fs.readdir(path.join(dshRoot, 'profiles'), { withFileTypes: true }).catch(() => []);
  for (const dir of dirs.filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')) {
    const root = path.join(dshRoot, 'profiles', dir.name);
    if (!await fs.stat(path.join(root, 'package.json')).catch(() => null)) continue;
    const configPath = path.join(root, 'cordis.patch.yml');
    const profile = {
      id: 'dsh-' + hash(root).slice(0, 16), agent: 'dsh', label: dir.name,
      root, configPath, installed: true, source: 'discovered',
      note: 'Cordis 插件随 DSH 进程运行。',
    };
    profiles.push(profile);
    try {
      for (const row of rows((await yamlDocument(configPath)).toJS())) {
        if (String(row.id).startsWith('im-link')) continue;
        findings.push({
          id: hash(configPath + row.id).slice(0, 24), profileId: profile.id,
          name: '飞书 · ' + dir.name, pluginId: row.id, pluginName: row.name,
          configPath, cwd: row.config?.workspace || '',
          appIdKey: row.config?.appIdEnv || 'FEISHU_APP_ID',
          appSecretKey: row.config?.appSecretEnv || 'FEISHU_APP_SECRET',
          credentialFile: path.join(dshRoot, '.credentials.yaml'),
        });
      }
    } catch { errors.push({ profileId: profile.id, message: '配置未能读取；没有修改原文件。' }); }
  }
  return { profiles, findings, errors };
}
export async function legacyCredentials(finding) {
  const doc = await yamlDocument(finding.credentialFile);
  const data = doc.toJS() || {};
  const get = (key) => {
    const value = process.env[key] || data.refs?.[key] || data[key] || data.credentials?.[key];
    return typeof value === 'string' ? value : value?.value;
  };
  const appId = get(finding.appIdKey), appSecret = get(finding.appSecretKey);
  if (!appId || !appSecret) throw new Error('已发现插件，但无法自动读取接入信息。请在添加渠道时手动填写。');
  return { appId, appSecret };
}
export function dshModule(profile, name) {
  return createRequire(path.join(profile.root, 'package.json')).resolve(name);
}
export async function nodeExecutable() {
  if (!process.versions.electron) return process.execPath;
  const dirs = (process.env.PATH || '').split(path.delimiter);
  dirs.push('/opt/homebrew/bin', '/usr/local/bin', 'C:\\Program Files\\nodejs');
  const candidates = [path.join(process.resourcesPath, process.platform === 'win32' ? 'node.exe' : 'node')];
  for (const dir of dirs) candidates.push(path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node'));
  for (const file of candidates) if (await fs.stat(file).catch(() => null)) return file;
  throw new Error('未找到 Node.js。请安装 Node.js 22 或更高版本后重试。');
}
