import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { JsonStore, delay } from '../src/core/files.mjs';
import { Conversations } from '../src/core/conversations.mjs';
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { resolve, promise }; };
async function waitFor(predicate) {
  for (let i = 0; i < 250; i++) { if (await predicate()) return; await delay(10); }
  throw new Error('condition did not settle');
}
async function fixture(t, run, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'im-link-conversations-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sent = [], calls = [];
  const store = new JsonStore(path.join(root, 'sessions.json'), { chats: {}, seen: [] });
  const driver = { run: async (request) => {
    calls.push(request);
    const result = await run(request);
    await request.onSession(request.session.id);
    return result;
  }};
  const engine = new Conversations({ store, driver, send: async (chatId, text, id) => { sent.push({ chatId, text, id }); }, revision: 1, ...extra });
  return { engine, store, calls, sent };
}
test('busy /new is a barrier: A result, new confirmation, then B in an empty session', async (t) => {
  const gate = deferred();
  const f = await fixture(t, async ({ text }) => { if (text === 'A') await gate.promise; return 'result ' + text; });
  await f.engine.ingest({ id: 'a', chatId: 'one', text: 'A' });
  await waitFor(() => f.calls.length === 1);
  await f.engine.ingest({ id: 'new', chatId: 'one', text: '/new' });
  await f.engine.ingest({ id: 'b', chatId: 'one', text: 'B' });
  assert.equal(f.calls.length, 1);
  gate.resolve(); await f.engine.idle();
  assert.deepEqual(f.sent.map((item) => item.text), ['将在当前任务完成后新建会话。', 'result A', '已新建会话。', 'result B']);
  assert.notEqual(f.calls[0].session.id, f.calls[1].session.id);
  assert.equal(f.calls[1].session.fresh, true);
});
test('private conversations are isolated and persisted exact IDs resume', async (t) => {
  const f = await fixture(t, async ({ text }) => text);
  await f.engine.ingest({ id: 'a', chatId: 'one', text: 'one' }); await f.engine.idle();
  await f.engine.ingest({ id: 'b', chatId: 'two', text: 'two' }); await f.engine.idle();
  const previous = (await f.store.read()).chats.one.session.id;
  assert.notEqual(previous, (await f.store.read()).chats.two.session.id);
  const second = new Conversations({ store: f.store, driver: { run: async (request) => {
    assert.equal(request.session.id, previous); assert.equal(request.session.fresh, false); return 'resumed';
  }}, send: async () => {}, revision: 1 });
  await second.recover(); await second.idle();
  await second.ingest({ id: 'c', chatId: 'one', text: 'resume' }); await second.idle();
});
test('switching binding generation resets context even when switching back to an old Agent', async (t) => {
  const f = await fixture(t, async () => 'done');
  await f.engine.ingest({ id: 'a', chatId: 'one', text: 'old' }); await f.engine.idle();
  const old = (await f.store.read()).chats.one.session.id;
  let next;
  const second = new Conversations({ store: f.store, revision: 3, send: async () => {}, driver: { run: async ({ session }) => { next = session; return 'new'; } } });
  await second.ingest({ id: 'b', chatId: 'one', text: 'after switch' }); await second.idle();
  assert.equal(next.fresh, true); assert.notEqual(next.id, old);
});
test('duplicate channel events never execute a second task', async (t) => {
  const f = await fixture(t, async () => 'done');
  await f.engine.ingest({ id: 'a', chatId: 'one', text: 'hello' }); await f.engine.idle();
  assert.equal(await f.engine.ingest({ id: 'a', chatId: 'one', text: 'hello' }), false);
  assert.equal(f.calls.length, 1);
});
test('Agent question replies resume the right task while /new remains queued', async (t) => {
  const f = await fixture(t, async ({ text, ask }) => text === 'question' ? 'answer ' + await ask('Choose A or B') : 'result ' + text);
  await f.engine.ingest({ id: 'a', chatId: 'one', text: 'question' });
  await waitFor(() => f.engine.questions.has('one'));
  await f.engine.ingest({ id: 'n', chatId: 'one', text: '/new' });
  await f.engine.ingest({ id: 'b', chatId: 'one', text: 'new-task' });
  assert.equal(f.calls.length, 1);
  await f.engine.ingest({ id: 'answer', chatId: 'one', text: '/reply A' });
  await f.engine.idle();
  assert(f.sent.some((item) => item.text === 'answer A'));
  assert.equal(f.sent.at(-2).text, '已新建会话。');
  assert.equal(f.sent.at(-1).text, 'result new-task');
  assert.equal(f.calls.length, 2);
});
test('delivery retry does not rerun the Agent after a send failure', async (t) => {
  let failed = true;
  const f = await fixture(t, async () => 'saved result', { send: async () => { if (failed) throw new Error('offline'); } });
  await f.engine.ingest({ id: 'a', chatId: 'one', text: 'do work' }); await f.engine.idle();
  assert.equal((await f.store.read()).chats.one.queue[0].status, 'reply_pending');
  failed = false; f.engine.pump('one'); await f.engine.idle();
  assert.equal(f.calls.length, 1); assert.equal((await f.store.read()).chats.one.queue.length, 0);
});
test('a process crash never automatically replays a task with unknown side effects', async (t) => {
  const f = await fixture(t, async () => { throw new Error('must not run'); });
  await f.store.update((state) => {
    state.chats.one = { revision: 1, queue: [{ id: 'crashed', kind: 'message', status: 'running', text: 'change files' }], session: { id: 'old', fresh: false } };
  });
  await f.engine.recover(); await f.engine.idle();
  assert.equal(f.calls.length, 0); assert.match(f.sent[0].text, /未自动重做/);
});
test('group events do not create tasks or sessions', async (t) => {
  const f = await fixture(t, async () => 'done');
  await f.engine.ingest({ id: 'g', chatId: 'group', chatType: 'group', text: 'hello' });
  assert.equal(f.calls.length, 0); assert.deepEqual((await f.store.read()).chats, {});
});
test('binding change can stop new task admission without interrupting an active task', async (t) => {
  let accepting = true;
  const gate = deferred();
  const f = await fixture(t, async () => { await gate.promise; return 'finished'; }, { canStart: async () => accepting });
  await f.engine.ingest({ id: 'a', chatId: 'one', text: 'A' }); await waitFor(() => f.calls.length === 1);
  accepting = false;
  await f.engine.ingest({ id: 'b', chatId: 'one', text: 'B' });
  gate.resolve(); await f.engine.idle();
  assert.equal(f.calls.length, 1); assert.equal((await f.store.read()).chats.one.queue[0].text, 'B');
});

test('images queued after /new enter the new session, never interrupting the running task', async (t) => {
  const gate = deferred();
  const f = await fixture(t, async ({ text, images }) => { if (text === 'A') await gate.promise; return images.length ? 'looked at image' : 'finished A'; });
  await f.engine.ingest({ id: 'a', chatId: 'one', text: 'A' }); await waitFor(() => f.calls.length === 1);
  await f.engine.ingest({ id: 'new', chatId: 'one', text: '/new' });
  await f.engine.ingest({ id: 'image', chatId: 'one', images: [{ imageKey: 'picture' }] });
  gate.resolve(); await f.engine.idle();
  assert.deepEqual(f.sent.slice(1).map((item) => item.text), ['finished A', '已新建会话。', 'looked at image']);
  assert.notEqual(f.calls[0].session.id, f.calls[1].session.id);
  assert.equal(f.calls[1].session.fresh, true); assert.equal(f.calls[1].images[0].imageKey, 'picture');
});

test('a picture while answering a permission question is queued as a task, never treated as approval', async (t) => {
  const f = await fixture(t, async ({ text, ask, images }) => images.length ? 'image-task' : 'answer ' + await ask('Allow?'));
  await f.engine.ingest({ id: 'question', chatId: 'one', text: 'ask' }); await waitFor(() => f.engine.questions.has('one'));
  await f.engine.ingest({ id: 'picture', chatId: 'one', text: '允许', images: [{ imageKey: 'key' }] });
  assert(f.engine.questions.has('one')); assert.equal(f.calls.length, 1);
  await f.engine.ingest({ id: 'answer', chatId: 'one', text: '拒绝' }); await f.engine.idle();
  assert.deepEqual(f.sent.map((item) => item.text), ['Allow?', 'answer 拒绝', 'image-task']);
});
