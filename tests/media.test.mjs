import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { Feishu, parseFeishuEvent } from '../src/adapters/feishu.mjs';
import { ImageStore, MAX_IMAGE_BYTES, imageType, MediaError } from '../src/core/media.mjs';
import { Conversations } from '../src/core/conversations.mjs';
import { JsonStore } from '../src/core/files.mjs';
import { DshDriver } from '../src/adapters/dsh-plugin.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPQyXjxHwAEvAJ8LgkgXQAAAABJRU5ErkJggg==', 'base64');
const event = (type, content, extra = {}) => ({ message: { message_type: type, content: JSON.stringify(content), chat_type: 'p2p', chat_id: 'chat', message_id: 'message', ...extra } });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'im-link-media-'));
  const cwd = path.join(root, 'workspace'); await fs.mkdir(cwd);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, cwd, media: new ImageStore(path.join(root, 'media'), cwd) };
}
const transport = (client) => new Feishu({}, { client, ws: { close() {} } });

test('Feishu image and mixed localized post messages retain image keys and captions', () => {
  assert.deepEqual(parseFeishuEvent(event('image', { image_key: 'img_1' })), {
    id: 'message', chatId: 'chat', chatType: 'p2p', text: '', images: [{ imageKey: 'img_1' }],
  });
  const post = { title: '看这两张图', content: [[{ tag: 'text', text: '比较差异' }, { tag: 'img', image_key: 'one' }], [{ tag: 'img', image_key: 'two' }]] };
  for (const content of [post, { zh_cn: post }, { en_us: post }]) {
    const parsed = parseFeishuEvent(event('post', content));
    assert.equal(parsed.text, '看这两张图\n比较差异');
    assert.deepEqual(parsed.images, [{ imageKey: 'one' }, { imageKey: 'two' }]);
  }
  assert.equal(parseFeishuEvent(event('image', { image_key: 'img' }, { chat_type: 'group' })), null);
  assert.equal(parseFeishuEvent(event('image', {})), null);
  assert.equal(parseFeishuEvent(event('post', { content: 'malformed' })), null);
  assert.equal(parseFeishuEvent(event('text', null)), null);
});

test('Feishu downloads message resources with a byte cap and closes streams on errors', async () => {
  let request;
  const client = { im: { messageResource: { get: async (value) => { request = value; return { getReadableStream: () => Readable.from([png]) }; } } } };
  const im = transport(client);
  assert.deepEqual(await im.downloadImage('msg', 'img'), png);
  assert.deepEqual(request, { path: { message_id: 'msg', file_key: 'img' }, params: { type: 'image' } });
  const large = Readable.from([Buffer.alloc(MAX_IMAGE_BYTES), Buffer.from([1])]);
  client.im.messageResource.get = async () => ({ getReadableStream: () => large });
  await assert.rejects(im.downloadImage('msg', 'img'), /5 MB/);
  assert(large.destroyed);
  client.im.messageResource.get = async () => { throw new Error('private transport detail'); };
  await assert.rejects(im.downloadImage('msg', 'img'), (e) => e instanceof MediaError && !e.message.includes('private'));
});

test('image cache snapshots local Markdown replies and confines file references to the workspace', async (t) => {
  const { media, cwd, root } = await fixture(t);
  const file = path.join(cwd, '截图 文件.png'); await fs.writeFile(file, png);
  const reply = await media.output('这是结果\n![预览](<' + file + '>)', 'job');
  assert.equal(reply.images.length, 1); assert.equal(reply.images[0].mimeType, 'image/png');
  assert.match(reply.text, /这是结果/); assert(!reply.text.includes(file));
  await fs.rm(file);
  assert.deepEqual(await fs.readFile(reply.images[0].path), png, 'Reply must survive deletion of the Agent original');
  assert.equal(await media.output('![外部](https://example.com/image.png)', 'remote'), '![外部](https://example.com/image.png)');
  const outside = path.join(root, 'outside.png'); await fs.writeFile(outside, png);
  await assert.rejects(media.output('![外部](' + outside + ')', 'no'), /工作目录之外/);
  await assert.rejects(media.output({ images: Array(5).fill({ data: png }) }, 'many'), /4 张/);
  await assert.rejects(media.input({ id: 'x', images: Array(5).fill({ imageKey: 'x' }) }, {}), /4 张/);
  assert.throws(() => imageType(Buffer.from('<svg/>')), /格式/);
  assert.throws(() => imageType(Buffer.alloc(MAX_IMAGE_BYTES + 1)), /5 MB/);
  await media.cleanup('job');
  assert.equal(await fs.stat(reply.images[0].path).catch(() => null), null);
  assert(await fs.stat(outside));
});

test('image uploads and retry delivery use the same chat and stable per-part UUIDs', async (t) => {
  const { media } = await fixture(t);
  const image = await media.save('job', 'out', png);
  const messages = []; let fail = true, uploads = 0;
  const im = transport({ im: {
    image: { create: async (request) => { uploads++; assert.deepEqual(request.data.image, png); return { image_key: 'uploaded' }; } },
    message: { create: async (request) => {
      messages.push(request.data);
      if (fail && request.data.msg_type === 'image') { fail = false; return { code: 99 }; }
      return { code: 0 };
    } },
  } });
  const reply = { text: '图片说明', images: [image] };
  await assert.rejects(im.send('original-chat', reply, 'result:job'), /图片发送失败/);
  await im.send('original-chat', reply, 'result:job');
  assert.equal(uploads, 2);
  assert(messages.every((item) => item.receive_id === 'original-chat'));
  assert.equal(messages[0].uuid, messages[2].uuid); assert.equal(messages[1].uuid, messages[3].uuid);
  assert.notEqual(messages[0].uuid, messages[1].uuid);
  assert.deepEqual(JSON.parse(messages[3].content), { image_key: 'uploaded' });
});

test('image-only tasks persist replies for restart delivery without rerunning the Agent', async (t) => {
  const { media, root } = await fixture(t);
  const store = new JsonStore(path.join(root, 'sessions.json'), { chats: {}, seen: [] });
  let executions = 0, downloads = 0;
  const options = { store, revision: 1, prepareInput: (job) => media.input(job, { downloadImage: async () => { downloads++; return png; } }),
    prepareResult: (result, id) => media.output(result, id), cleanup: (id) => media.cleanup(id),
    driver: { run: async ({ images, onSession, session }) => {
      executions++; assert.equal(images.length, 1); assert.deepEqual(await fs.readFile(images[0].path), png);
      await onSession(session.id); return { images: [{ data: png }] };
    } },
  };
  const first = new Conversations({ ...options, send: async () => { throw new Error('offline'); } });
  await first.ingest({ id: 'img', chatId: 'one', images: [{ imageKey: 'key' }] }); await first.idle();
  const pending = (await store.read()).chats.one.queue[0];
  assert.equal(pending.status, 'reply_pending'); assert.equal(pending.result.images.length, 1);
  assert(!JSON.stringify(pending).includes(png.toString('base64')));
  const sent = [];
  const second = new Conversations({ ...options, send: async (chat, reply) => { sent.push({ chat, reply }); assert.deepEqual(await fs.readFile(reply.images[0].path), png); } });
  await second.recover(); await second.idle();
  assert.equal(executions, 1); assert.equal(downloads, 1); assert.equal(sent[0].chat, 'one');
  assert.equal(await fs.stat(pending.result.images[0].path).catch(() => null), null);
  assert.equal(await second.ingest({ id: 'img', chatId: 'one', images: [{ imageKey: 'key' }] }), false);
});

test('image input errors produce actionable replies without invalidating channel health', async (t) => {
  const { root } = await fixture(t); let failed = 0, called = 0; const sent = [];
  const engine = new Conversations({ store: new JsonStore(path.join(root, 'queue.json'), { chats: {}, seen: [] }), revision: 1,
    driver: { run: async () => { called++; } }, prepareInput: async () => { throw new MediaError('图片超过 5 MB'); },
    failure: () => { failed++; }, send: async (_chat, text) => { sent.push(text); },
  });
  await engine.ingest({ id: 'image', chatId: 'chat', images: [{ imageKey: 'large' }] }); await engine.idle();
  assert.equal(sent[0], '图片超过 5 MB'); assert.equal(failed, 0); assert.equal(called, 0);
});

test('DSH admits images through its durable attachment service and preserves mixed content', async (t) => {
  const { media } = await fixture(t); const image = await media.save('job', 'in', png); let received, saved;
  const attachment = { attachmentId: 'durable', mediaType: 'image/png', bytes: png.length, width: 1, height: 1 };
  const ctx = { get: (name) => name === 'attachments' ? { saveImages: async (inputs) => { saved = inputs; return [attachment]; } } : null };
  const driver = new DshDriver(ctx, {}, '', { createUserMessage: (value) => value });
  driver.handles.set('session', { agent: { id: 'session', session: { seq: 0, snapshotEvents: () => [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已看图' }] } } }] }, followup: (value) => { received = value; }, whenIdle: async () => {} } });
  assert.equal(await driver.run({ text: '看看截图', images: [image], session: { id: 'session' }, onSession: async () => {}, ask: async () => {} }), '已看图');
  assert.deepEqual(saved[0].data, png); assert.equal(saved[0].mediaType, 'image/png');
  assert.deepEqual(received.content[1], { type: 'image', attachment }); assert.match(received.content[0].text, /看看截图/);
  assert.deepEqual(received.source, { kind: 'user' });
});

test('DSH explicitly text-only models do not silently discard the supplied image', async () => {
  const ctx = { get: (name) => ({
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'text-only' }) },
    llm: { resolveModelInfo: async () => ({ inputModalities: ['text'] }) },
  })[name] };
  const driver = new DshDriver(ctx, {}, '', {});
  await assert.rejects(driver.run({ text: '', images: [{}], session: { id: 'x' } }), /不支持看图/);
});
