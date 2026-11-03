import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as plugin from '../src/adapters/dsh-plugin.mjs';
import { AgentHost } from '../src/runtime/host.mjs';

// Opt in against an installed DSH without modifying its profile or connecting to IM.
const profileRoot = process.env.IM_LINK_DSH_PROFILE;

test('installed DSH stores IM image input as a native durable image reference', {
  skip: !profileRoot && 'Set IM_LINK_DSH_PROFILE to an installed DSH profile',
}, async (t) => {
  const require = createRequire(path.join(profileRoot, 'package.json'));
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const { default: Attachments } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-attachment-local')).href);
  const llm = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'im-link-dsh-image-'));
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  await ctx.plugin(Attachments, { dshHome: root });
  const file = path.join(root, 'image.png');
  await fs.writeFile(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPQyXjxHwAEvAJ8LgkgXQAAAABJRU5ErkJggg==', 'base64'));
  let received;
  const driver = new plugin.DshDriver(ctx, {}, root, { createUserMessage: llm.createUserMessage });
  driver.handles.set('fixture', { agent: {
    id: 'fixture', session: { seq: 0, snapshotEvents: () => [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'image accepted' }] } } }] },
    followup: (message) => { received = message; }, whenIdle: async () => {},
  } });
  assert.equal(await driver.run({ text: 'look', images: [{ path: file }], session: { id: 'fixture' }, onSession: async () => {}, ask: async () => {} }), 'image accepted');
  const image = received.content.find((block) => block.type === 'image');
  assert(image?.attachment.attachmentId);
  const stored = await ctx.attachments.readImage(image.attachment);
  assert(stored.data.length > 0); assert.equal(stored.ref.width, 1); assert.equal(stored.ref.height, 1);
});
test('DSH plugin starts on mount and closes its host when its Cordis fiber unloads', {
  skip: !profileRoot && 'Set IM_LINK_DSH_PROFILE to an installed DSH profile',
}, async (t) => {
  const require = createRequire(path.join(profileRoot, 'package.json'));
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'im-link-dsh-'));
  const ctx = new Context();
  let host;
  const start = AgentHost.prototype.start;
  t.mock.method(AgentHost.prototype, 'start', async function () {
    host = this;
    return start.call(this);
  });
  t.after(async () => {
    await ctx.fiber.dispose();
    await host?.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  ctx.provide('agents', {});
  ctx.provide('agentDefaultModel', {});
  const fiber = ctx.plugin(plugin, { home: root, profileId: 'fixture', profileRoot });
  await fiber;
  for (let i = 0; i < 100 && !host?.timer; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(host?.timer, 'The plugin mounted, but its AgentHost never started');
  assert.equal((await fs.stat(path.join(root, 'runtime'))).isDirectory(), true);
  await fiber.dispose();
  assert.equal(host.closed, true, 'Unloading the plugin must close its host');
});
