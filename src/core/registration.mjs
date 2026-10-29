import path from 'node:path';
import fs from 'node:fs/promises';
import { readJson } from './files.mjs';
import { yamlDocument } from './discovery.mjs';

export const ownerId = 'im-link-managed';
export async function configureProfile({ profile, root, appRoot, node, transaction, enabled = true, disablePluginId }) {
  if (profile.agent === 'claude') {
    const config = await readJson(profile.configPath, {});
    if (config.disableAllHooks) throw new Error('当前 Claude Code 设置禁用了生命周期钩子，请先检查设置。');
    config.hooks ||= {};
    for (const event of ['SessionStart', 'SessionEnd']) {
      const entries = config.hooks[event] || [];
      if (!Array.isArray(entries)) throw new Error('现有 hooks 格式不受支持，未覆盖原配置。');
      config.hooks[event] = entries.map((entry) => ({
        ...entry, hooks: (entry.hooks || []).filter((hook) => !isOwnedHook(hook))
      })).filter((entry) => entry.hooks.length);
      if (enabled) config.hooks[event].push({
        hooks: [{
          type: 'command', command: node,
          args: [path.join(appRoot, 'src/runtime/claude-hook.mjs'), '--im-link', '--home', root, '--profile', profile.id, '--event', event],
          timeout: 10,
        }],
      });
      if (!config.hooks[event].length) delete config.hooks[event];
    }
    await transaction.write(profile.configPath, JSON.stringify(config, null, 2) + '\n');
    return;
  }
  const document = await yamlDocument(profile.configPath);
  if (!Array.isArray(document.toJS())) throw new Error('DSH 补丁层不是数组，未修改原文件。');
  // Work on YAML nodes to preserve comments, !!js tags and unrelated entries.
  for (let index = document.contents.items.length - 1; index >= 0; index--) {
    const row = document.contents.items[index];
    const value = row.toJSON();
    if (Array.isArray(value.insert)) {
      const list = row.get('insert', true);
      for (let i = list.items.length - 1; i >= 0; i--) {
        if (list.items[i].get?.('id') === ownerId) list.items.splice(i, 1);
      }
      if (!list.items.length && Object.keys(value).length === 1) document.contents.items.splice(index, 1);
    }
  }
  if (disablePluginId) {
    document.add({ id: disablePluginId, disabled: true });
  }
  if (enabled) document.add({ insert: [{
    id: ownerId, name: path.join(appRoot, 'src/adapters/dsh-plugin.mjs'),
    config: { home: root, profileId: profile.id, profileRoot: profile.root },
  }] });
  await transaction.write(profile.configPath, document.toString());
}
export function isOwnedHook(hook) {
  return Array.isArray(hook.args) && hook.args.includes('--im-link') && hook.args.some((arg) => String(arg).endsWith('claude-hook.mjs'));
}
