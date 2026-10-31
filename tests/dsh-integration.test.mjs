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
