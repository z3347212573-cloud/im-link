import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { JsonStore, ConfigTransaction, atomicWrite } from '../src/core/files.mjs';
import { Vault, systemKey } from '../src/core/vault.mjs';
import { Manager } from '../src/core/manager.mjs';
import { configureProfile } from '../src/core/registration.mjs';
import { discover, yamlDocument, inspectProfile } from '../src/core/discovery.mjs';
import { parseFeishuEvent } from '../src/adapters/feishu.mjs';

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'im-link-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test('atomic updates preserve concurrent changes', async (t) => {
  const root = await temporary(t), store = new JsonStore(path.join(root, 'state.json'), { n: 0 });
  await Promise.all(Array.from({ length: 16 }, () => store.update((state) => { state.n++; })));
  assert.equal((await store.read()).n, 16);
});
test('transaction rolls back existing and newly created files', async (t) => {
  const root = await temporary(t), file = path.join(root, 'settings.json'), newFile = path.join(root, 'new.json');
  await atomicWrite(file, '{"unrelated":true}');
  const transaction = new ConfigTransaction(path.join(root, 'backups'));
  await transaction.write(file, '{"changed":true}');
  await transaction.write(newFile, '{}');
  await transaction.rollback();
  assert.equal(await fs.readFile(file, 'utf8'), '{"unrelated":true}');
  assert.equal(await fs.stat(newFile).catch(() => null), null);
});
test('rollback refuses to clobber a concurrent external edit', async (t) => {
  const root = await temporary(t), file = path.join(root, 'settings.json');
  await atomicWrite(file, '{}');
  const transaction = new ConfigTransaction(path.join(root, 'backups'));
  await transaction.write(file, '{"owned":1}');
  await atomicWrite(file, '{"user":2}');
  await assert.rejects(transaction.rollback(), /其他程序修改/);
  assert.equal(await fs.readFile(file, 'utf8'), '{"user":2}');
});
test('vault encrypts records and authenticates channel identity', async (t) => {
  const root = await temporary(t), key = randomBytes(32), vault = new Vault(root, async () => key);
  await vault.put('a', { appSecret: 'test-secret-that-must-not-leak' });
  assert.deepEqual(await vault.get('a'), { appSecret: 'test-secret-that-must-not-leak' });
  const raw = await fs.readFile(path.join(root, 'credentials.enc.json'), 'utf8');
  assert(!raw.includes('test-secret-that-must-not-leak'));
  const data = JSON.parse(raw); data.b = data.a;
  await atomicWrite(path.join(root, 'credentials.enc.json'), JSON.stringify(data));
  await assert.rejects(vault.get('b'));
});
test('Windows DPAPI key survives a new vault instance', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await temporary(t);
  const first = await systemKey(root);
  assert.equal(first.length, 32);
  assert.deepEqual(await systemKey(root), first);
  const vault = new Vault(root); await vault.put('test', { appSecret: 'fixture-only' });
  assert.equal((await new Vault(root).get('test')).appSecret, 'fixture-only');
});
test('Claude registration is idempotent and preserves unrelated hooks and permissions', async (t) => {
  const root = await temporary(t), profile = { agent: 'claude', id: 'claude-test', configPath: path.join(root, 'settings.json') };
  const original = { permissions: { deny: ['Read(.env)'] }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'original-hook' }] }] } };
  await atomicWrite(profile.configPath, JSON.stringify(original));
  const options = { profile, root, appRoot: process.cwd(), node: process.execPath, transaction: new ConfigTransaction(path.join(root, 'backups')) };
  await configureProfile(options); await configureProfile(options);
  const value = JSON.parse(await fs.readFile(profile.configPath, 'utf8'));
  assert.deepEqual(value.permissions, original.permissions);
  assert.equal(value.hooks.SessionStart.length, 2);
  assert.equal(value.hooks.SessionEnd.length, 1);
  assert.equal(value.hooks.SessionStart[1].hooks[0].command, process.execPath);
  assert(value.hooks.SessionStart[1].hooks[0].args.includes('--im-link'));
  assert.equal((await inspectProfile(profile)).extensionConfigured, true);
});
test('DSH YAML tags and comments survive install and uninstall', async (t) => {
  const root = await temporary(t), profile = { agent: 'dsh', id: 'dsh-test', root, configPath: path.join(root, 'cordis.patch.yml') };
  await atomicWrite(profile.configPath, '# user comment\n- id: custom\n  disabled: !!js process.platform === "win32"\n');
  const options = { profile, root, appRoot: process.cwd(), node: process.execPath, transaction: new ConfigTransaction(path.join(root, 'backups')) };
  await configureProfile(options); await configureProfile(options);
  let content = await fs.readFile(profile.configPath, 'utf8');
  assert(content.includes('# user comment')); assert(content.includes('!!js'));
  assert.equal((content.match(/id: im-link-managed/g) || []).length, 1);
  assert.equal((await inspectProfile(profile)).extensionConfigured, true);
  await configureProfile({ ...options, enabled: false });
  content = await fs.readFile(profile.configPath, 'utf8');
  assert(!content.includes('im-link-managed')); assert(content.includes('!!js')); assert(content.includes('# user comment'));
  assert.equal((await inspectProfile(profile)).extensionConfigured, false);
});
test('discovery only returns metadata, with no credential or source leakage', async (t) => {
  const root = await temporary(t), profile = path.join(root, '.dsh/profiles/web');
  await fs.mkdir(profile, { recursive: true });
  await atomicWrite(path.join(profile, 'package.json'), '{}');
  await atomicWrite(path.join(profile, 'cordis.patch.yml'), '- insert:\n    - id: old\n      name: dsh-feishu-bridge\n      config:\n        appSecret: never-return-this-secret\n- id: tagged\n  disabled: !!js process.platform === "win32"\n');
  const result = await discover(root);
  assert.equal(result.findings.length, 1);
  assert(!JSON.stringify(result).includes('never-return-this-secret'));
  assert.equal(result.errors.length, 0);
});
test('manager saves encrypted channels and preserves them when unbinding', async (t) => {
  const root = await temporary(t), vault = new Vault(root, async () => Buffer.alloc(32, 7));
  const manager = new Manager(root, { vault, home: root });
  await manager.scan();
  let snapshot = await manager.save({ name: 'Fixture', appId: 'cli_fixture123', appSecret: 'fixture-secret' });
  const id = snapshot.channels[0].id;
  assert(!JSON.stringify(snapshot).includes('fixture-secret'));
  snapshot = await manager.unbind(id);
  assert.equal(snapshot.channels[0].status, 'unbound');
  assert.equal((await vault.get(id)).appSecret, 'fixture-secret');
  snapshot = await manager.remove(id);
  assert.equal(snapshot.channels.length, 0); await assert.rejects(vault.get(id));
});
test('manager rejects duplicate robot IDs, even with a different display name', async (t) => {
  const root = await temporary(t), manager = new Manager(root, { vault: new Vault(root, async () => Buffer.alloc(32, 1)) });
  await manager.save({ name: 'One', appId: 'cli_one123', appSecret: 'fixture' });
  await assert.rejects(manager.save({ name: 'Two', appId: 'cli_one123', appSecret: 'fixture' }), /已经添加/);
});
test('credential rotation is encrypted and requires an unbound channel', async (t) => {
  const root = await temporary(t), vault = new Vault(root, async () => Buffer.alloc(32, 5));
  const manager = new Manager(root, { vault });
  const snapshot = await manager.save({ name: 'Rotate', appId: 'cli_rotate', appSecret: 'old-fixture' });
  const id = snapshot.channels[0].id;
  await manager.updateChannel(id, { appSecret: 'new-fixture' });
  assert.equal((await vault.get(id)).appSecret, 'new-fixture');
  assert(!(await fs.readFile(vault.store.file, 'utf8')).includes('new-fixture'));
  await manager.store.update((state) => { state.channels[0].binding = 'active'; });
  await assert.rejects(manager.updateChannel(id, { appSecret: 'must-not-apply' }), /先解绑/);
  assert.equal((await vault.get(id)).appSecret, 'new-fixture');
});
test('failed binding restores configuration and does not invent a binding', async (t) => {
  const root = await temporary(t), manager = new Manager(root, { vault: new Vault(root, async () => Buffer.alloc(32, 2)), node: process.execPath });
  const file = path.join(root, 'settings.json');
  await atomicWrite(file, '{"disableAllHooks":true,"other":"preserve"}');
  await manager.store.update((state) => { state.profiles.push({ id: 'test', agent: 'claude', configPath: file }); });
  const snapshot = await manager.save({ name: 'Unbound', appId: 'cli_fixture', appSecret: 'fixture' });
  await assert.rejects(manager.bind(snapshot.channels[0].id, 'test'), /禁用/);
  assert.equal((await manager.snapshot()).channels[0].binding, null);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).other, 'preserve');
});
test('Feishu ingress rejects groups and malformed messages', () => {
  const base = { message: { chat_type: 'p2p', message_type: 'text', chat_id: 'chat', message_id: 'msg', content: '{"text":"hello"}' } };
  assert.deepEqual(parseFeishuEvent(base), { id: 'msg', chatId: 'chat', chatType: 'p2p', text: 'hello' });
  assert.equal(parseFeishuEvent({ message: { ...base.message, chat_type: 'group' } }), null);
  assert.equal(parseFeishuEvent({ message: { ...base.message, message_type: 'image' } }), null);
  assert.equal(parseFeishuEvent({ message: { ...base.message, content: 'invalid' } }), null);
});
