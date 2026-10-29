import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigTransaction, JsonStore, atomicWrite } from '../src/core/files.mjs';
import { stateStore } from '../src/core/model.mjs';
import { conversationFile } from '../src/core/conversations.mjs';
import { restoreTransition } from '../src/core/transitions.mjs';

test('a failed target restores original binding, configuration and exact old session without replaying tasks', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'im-link-rollback-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'target.json'); await atomicWrite(file, '{"original":true}');
  const transaction = new ConfigTransaction(path.join(root, 'backups'));
  await transaction.write(file, '{"installed":true}');
  const state = stateStore(root);
  await state.update((value) => {
    value.channels = [{ id: 'channel', binding: 'target', revision: 2, transition: {
      previousBinding: 'original', backupId: transaction.id, sessions: { chat: { id: 'old-exact-session', fresh: false } }
    }}];
  });
  const sessions = new JsonStore(conversationFile(root, 'channel'), { chats: {}, seen: [] });
  await sessions.update((value) => {
    value.chats.chat = { session: { id: 'failed-target-session', fresh: false }, revision: 2, queue: [{ id: 'later', status: 'queued', text: 'next task' }] };
    value.seen = ['already-executed'];
  });
  assert.equal(await restoreTransition(root, 'channel', 2), true);
  const restored = (await state.read()).channels[0];
  assert.equal(restored.binding, 'original'); assert.equal(restored.revision, 3);
  assert.equal(await fs.readFile(file, 'utf8'), '{"original":true}');
  const chat = (await sessions.read()).chats.chat;
  assert.equal(chat.session.id, 'old-exact-session'); assert.equal(chat.revision, 3);
  assert.equal(chat.queue[0].id, 'later');
  assert.deepEqual((await sessions.read()).seen, ['already-executed']);
});
test('rollback preserves a target registration still used by another channel', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'im-link-shared-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'target.json'); await atomicWrite(file, '{"original":true}');
  const transaction = new ConfigTransaction(path.join(root, 'backups'));
  await transaction.write(file, '{"installed":true}');
  const store = stateStore(root);
  await store.update((value) => {
    value.channels = [
      { id: 'one', binding: 'target', revision: 2, transition: { previousBinding: 'old', backupId: transaction.id } },
      { id: 'two', binding: 'target', revision: 1 },
    ];
  });
  await restoreTransition(root, 'one', 2);
  assert.equal(await fs.readFile(file, 'utf8'), '{"installed":true}');
  assert.equal((await store.read()).channels[1].binding, 'target');
});
