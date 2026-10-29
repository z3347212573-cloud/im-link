import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentHost } from '../src/runtime/host.mjs';
import { Vault } from '../src/core/vault.mjs';
import { stateStore } from '../src/core/model.mjs';
import { delay } from '../src/core/files.mjs';

async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(10); }
  throw new Error('runtime condition did not settle');
}
test('runtime transfers channel ownership only after tasks finish, with no dual receivers', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'im-link-runtime-'));
  const store = stateStore(root), vault = new Vault(root, async () => Buffer.alloc(32, 8));
  await vault.put('channel', { appId: 'cli_fixture', appSecret: 'fixture' });
  await store.update((state) => {
    state.profiles = [{ id: 'a', agent: 'dsh' }, { id: 'b', agent: 'claude' }];
    state.channels = [{ id: 'channel', binding: 'a', revision: 1, name: 'test' }];
  });
  let active = 0, maxActive = 0, unblock, receiver;
  const blocked = new Promise((resolve) => { unblock = resolve; });
  const calls = [], replies = [];
  const transportFactory = () => ({
    start: async (callback) => { receiver = callback; active++; maxActive = Math.max(maxActive, active); },
    send: async (_chat, text) => { replies.push(text); },
    close: async () => { active--; },
  });
  const driverFactory = async (profile) => ({
    run: async ({ text, session, onSession }) => {
      calls.push({ profile: profile.id, text, session });
      if (text === 'A') await blocked;
      await onSession(session.id);
      return 'done ' + text;
    },
  });
  const first = new AgentHost(root, 'a', driverFactory, { vault, transportFactory });
  const second = new AgentHost(root, 'b', driverFactory, { vault, transportFactory });
  t.after(async () => { await first.close(); await second.close(); await fs.rm(root, { recursive: true, force: true }); });
  await first.start(); await second.start();
  await receiver({ id: 'msg-a', chatId: 'private', text: 'A' });
  await until(() => calls.length === 1);
  await store.update((state) => { state.channels[0].pending = { profileId: 'b' }; });
  await receiver({ id: 'msg-b', chatId: 'private', text: 'B' });
  await first.tick();
  assert.equal((await store.read()).channels[0].binding, 'a');
  assert.equal(calls.length, 1);
  unblock();
  await until(() => first.channels.get('channel').engine.busy === 0);
  await first.tick(); await second.tick();
  await until(() => replies.includes('done B'));
  assert.equal((await store.read()).channels[0].binding, 'b');
  assert.equal(calls[1].profile, 'b'); assert.equal(calls[1].session.fresh, true);
  assert.notEqual(calls[0].session.id, calls[1].session.id);
  assert.equal(maxActive, 1); assert.deepEqual(replies, ['done A', 'done B']);
});
test('two Agent hosts cannot simultaneously acquire the same channel', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'im-link-lock-'));
  const store = stateStore(root), vault = new Vault(root, async () => Buffer.alloc(32, 9));
  await vault.put('channel', { appId: 'cli_fixture', appSecret: 'fixture' });
  await store.update((state) => {
    state.profiles = [{ id: 'a', agent: 'dsh' }];
    state.channels = [{ id: 'channel', binding: 'a', revision: 1 }];
  });
  let receivers = 0;
  const options = { vault, transportFactory: () => ({
    start: async () => { receivers++; }, close: async () => { receivers--; }, send: async () => {},
  }) };
  const a = new AgentHost(root, 'a', async () => ({}), options), b = new AgentHost(root, 'a', async () => ({}), options);
  t.after(async () => { await a.close(); await b.close(); await fs.rm(root, { recursive: true, force: true }); });
  await a.start(); await b.start();
  assert.equal(receivers, 1);
  await a.close(); await b.tick(); assert.equal(receivers, 1);
});
