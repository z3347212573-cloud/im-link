import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { JsonStore } from './files.mjs';

export const dataRoot = () => process.env.IM_LINK_HOME || path.join(os.homedir(), '.im-link');
export const stateStore = (root) => new JsonStore(path.join(root, 'state.json'), {
  version: 1, profiles: [], channels: [], events: []
});
export function record(state, action, detail, channelId = null) {
  state.events.unshift({ id: randomUUID(), at: new Date().toISOString(), action, detail, channelId });
  state.events = state.events.slice(0, 200);
}
export function validateChannel(input) {
  const name = String(input.name || '').trim();
  const appId = String(input.appId || '').trim();
  const appSecret = String(input.appSecret || '').trim();
  if (!name || name.length > 80) throw new Error('请输入 1—80 个字符的渠道名称。');
  if (!/^cli_[a-zA-Z0-9]+$/.test(appId)) throw new Error('请输入飞书自建应用的 App ID（以 cli_ 开头）。');
  if (!appSecret || appSecret.length > 1024) throw new Error('请输入 App Secret。');
  if (input.cwd && !path.isAbsolute(input.cwd)) throw new Error('工作文件夹需要是绝对路径。');
  return { name, appId, appSecret, cwd: input.cwd || '' };
}
export function publicChannel(channel, runtime = null) {
  const active = runtime && Date.now() - runtime.heartbeat < 15000;
  return { ...channel, runtime: active ? {
    status: runtime.status, busy: runtime.busy || 0, heartbeat: runtime.heartbeat,
    lastError: runtime.lastError || null, lastMessageAt: runtime.lastMessageAt || null
  } : null };
}
