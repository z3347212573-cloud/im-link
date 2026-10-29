import path from 'node:path';
import { ConfigTransaction, JsonStore, readJson } from './files.mjs';
import { conversationFile } from './conversations.mjs';
import { stateStore, record } from './model.mjs';

export async function sessionSnapshot(root, channelId) {
  const data = await readJson(conversationFile(root, channelId), { chats: {} });
  return Object.fromEntries(Object.entries(data.chats || {}).map(([id, chat]) => [id, chat.session]));
}

export async function restoreTransition(root, channelId, expectedRevision) {
  const store = stateStore(root);
  return store.update(async (state) => {
    const channel = state.channels.find((item) => item.id === channelId);
    if (!channel?.transition || channel.revision !== expectedRevision) return false;
    const transition = channel.transition;
    const otherReferences = state.channels.some((item) => item.id !== channelId &&
      (item.binding === channel.binding || item.pending?.profileId === channel.binding));
    let configRestored = true;
    if (!otherReferences && transition.backupId) {
      const transaction = new ConfigTransaction(path.join(root, 'backups'));
      transaction.id = transition.backupId;
      transaction.changes = await readJson(path.join(root, 'backups', transition.backupId, 'manifest.json'), []);
      try { await transaction.rollback(); } catch { configRestored = false; }
    }
    channel.binding = transition.previousBinding;
    channel.revision++;
    channel.pending = null;
    channel.transition = null;
    channel.verifiedAt = null;
    channel.status = channel.binding ? 'waiting_restart' : 'unbound';
    channel.recoveryNote = configRestored
      ? '目标接入未成功，已恢复原绑定。原 Agent 未运行时，请手动重新打开。'
      : '已恢复原绑定；目标配置被其他操作修改，保留了现场，请检查备份恢复记录。';
    const sessions = new JsonStore(conversationFile(root, channelId), { chats: {}, seen: [] });
    await sessions.update((data) => {
      for (const [id, chat] of Object.entries(data.chats)) {
        chat.session = transition.sessions?.[id] || null;
        chat.revision = channel.revision;
      }
    });
    record(state, '恢复原绑定', channel.recoveryNote, channelId);
    return true;
  });
}
