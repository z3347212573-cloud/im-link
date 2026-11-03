import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClaudeDriver } from '../src/adapters/claude.mjs';

function sendMessage(response, content) {
  const usage = { input_tokens: 10, output_tokens: 8 };
  const message = { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture', content, stop_reason: content[0].type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null, usage };
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const emit = (event, data) => response.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  emit('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  content.forEach((block, index) => {
    if (block.type === 'text') {
      emit('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else {
      emit('content_block_start', { type: 'content_block_start', index, content_block: { ...block, input: {} } });
      emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    emit('content_block_stop', { type: 'content_block_stop', index });
  });
  emit('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 8 } });
  emit('message_stop', { type: 'message_stop' }); response.end();
}

test('native Claude SDK creates and resumes exact sessions against a local fixture model', { timeout: 45000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'im-link-native-'));
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    if (request.url.includes('count_tokens')) {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"input_tokens":10}'); return;
    }
    if (request.url.includes('/messages')) {
      requests.push(body);
      const transcript = JSON.stringify(body.messages);
      if (transcript.includes('ask-fixture') && !transcript.includes('tool_result')) {
        sendMessage(response, [{ type: 'tool_use', id: 'tool_ask_fixture', name: 'AskUserQuestion', input: {
          questions: [{ question: 'Choose a color', header: 'Color', multiSelect: false, options: [
            { label: 'Blue', description: 'Blue option' }, { label: 'Green', description: 'Green option' },
          ] }],
        } }]); return;
      }
      if (transcript.includes('permission-fixture') && !transcript.includes('tool_result')) {
        sendMessage(response, [{ type: 'tool_use', id: 'tool_write_fixture', name: 'Write', input: {
          file_path: path.join(root, 'should-not-exist.txt'), content: 'fixture',
        } }]); return;
      }
      sendMessage(response, [{ type: 'text', text: 'fixture-response-' + requests.length }]); return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = path.join(root, 'config'); await fs.mkdir(config);
  const changes = {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + server.address().port,
    ANTHROPIC_API_KEY: 'fixture-only', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0',
  };
  const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  Object.assign(process.env, changes);
  const driver = new ClaudeDriver({ root: config }, root);
  t.after(async () => {
    await driver.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await fs.rm(root, { recursive: true, force: true });
  });
  const id = randomUUID(); let observed;
  const first = await driver.run({ text: 'first-fixture-turn', session: { id, fresh: true }, onSession: async (value) => { observed = value; }, ask: async () => { throw new Error('unexpected question'); } });
  assert.equal(first, 'fixture-response-1'); assert.equal(observed, id);
  const second = await driver.run({ text: 'second-fixture-turn', session: { id, fresh: false }, onSession: async (value) => { assert.equal(value, id); }, ask: async () => { throw new Error('unexpected question'); } });
  assert.equal(second, 'fixture-response-2');
  assert(JSON.stringify(requests[1].messages).includes('first-fixture-turn'));
  assert(JSON.stringify(requests[1].messages).includes('second-fixture-turn'));
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPQyXjxHwAEvAJ8LgkgXQAAAABJRU5ErkJggg==';
  const imageFile = path.join(root, 'image.png'); await fs.writeFile(imageFile, Buffer.from(png, 'base64'));
  await driver.run({ text: 'image-fixture-turn', images: [{ path: imageFile }], session: { id, fresh: false }, onSession: async (value) => { assert.equal(value, id); }, ask: async () => { throw new Error('unexpected question'); } });
  const imageTurn = requests.at(-1).messages.findLast((message) => message.role === 'user' && Array.isArray(message.content) && message.content.some((block) => block.type === 'image'));
  assert(imageTurn, 'Native CLI did not send image content to the model');
  assert(imageTurn.content.some((block) => block.type === 'text' && block.text.includes('image-fixture-turn')));
  assert.equal(imageTurn.content.find((block) => block.type === 'image').source.media_type, 'image/png');
  assert.equal(imageTurn.content.find((block) => block.type === 'image').source.data, png);
  const imageOnlyId = randomUUID();
  await driver.run({ text: '', images: [{ path: imageFile }], session: { id: imageOnlyId, fresh: true }, onSession: async (value) => { assert.equal(value, imageOnlyId); }, ask: async () => { throw new Error('unexpected question'); } });
  assert(requests.at(-1).messages.some((message) => message.role === 'user' && Array.isArray(message.content) && message.content.some((block) => block.type === 'image')));
  let asked = false;
  await driver.run({ text: 'ask-fixture', session: { id: randomUUID(), fresh: true }, onSession: async () => {}, ask: async (question) => {
    assert(question.includes('Choose a color')); asked = true; return 'Blue';
  } });
  assert(asked, 'SDK did not relay AskUserQuestion');
  let approved = false;
  await driver.run({ text: 'permission-fixture', session: { id: randomUUID(), fresh: true }, onSession: async () => {}, ask: async (question) => {
    assert(question.includes('Write')); approved = true; return '拒绝';
  } });
  assert(approved, 'SDK did not relay tool approval');
  assert.equal(await fs.stat(path.join(root, 'should-not-exist.txt')).catch(() => null), null);
});
