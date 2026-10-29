import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const clone = (value) => structuredClone(value);
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return clone(fallback); throw error; }
}

export async function atomicWrite(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temp, text, { mode: 0o600, flag: 'wx' });
    const handle = await fs.open(temp, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}

export async function withLock(file, action, timeout = 8000) {
  const lock = file + '.lock';
  const token = randomUUID();
  const started = Date.now();
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (;;) {
    try {
      await fs.mkdir(lock);
      await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token }));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await readJson(path.join(lock, 'owner.json'), null);
      const stat = await fs.stat(lock).catch(() => null);
      if ((owner && !alive(owner.pid)) || (!owner && stat && Date.now() - stat.mtimeMs > 10000)) {
        await fs.rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > timeout) throw new Error('另一个配置操作尚未完成，请稍后重试。');
      await delay(40);
    }
  }
  try { return await action(); }
  finally {
    const owner = await readJson(path.join(lock, 'owner.json'), null);
    if (owner?.token === token) await fs.rm(lock, { recursive: true, force: true });
  }
}

export class JsonStore {
  constructor(file, initial) { this.file = file; this.initial = initial; }
  read() { return readJson(this.file, this.initial); }
  async update(action) {
    return withLock(this.file, async () => {
      const state = await this.read();
      const result = await action(state);
      await atomicWrite(this.file, JSON.stringify(state, null, 2));
      return result;
    });
  }
}

export class ConfigTransaction {
  constructor(root) { this.root = root; this.id = randomUUID(); this.changes = []; }
  async write(file, text) {
    const previous = await fs.readFile(file, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    await fs.mkdir(path.join(this.root, this.id), { recursive: true, mode: 0o700 });
    // Backups can contain existing credentials; they inherit restricted permissions.
    const backup = path.join(this.root, this.id, String(this.changes.length) + '.backup');
    if (previous !== null) await atomicWrite(backup, previous);
    await atomicWrite(file, text);
    this.changes.push({ file, backup: previous === null ? null : backup, appliedHash: hash(text) });
    await atomicWrite(path.join(this.root, this.id, 'manifest.json'), JSON.stringify(this.changes, null, 2));
  }
  async rollback() {
    const conflicts = [];
    for (const change of [...this.changes].reverse()) {
      const current = await fs.readFile(change.file, 'utf8').catch(() => null);
      if (current === null || hash(current) !== change.appliedHash) {
        conflicts.push(change.file);
        continue;
      }
      if (change.backup) await atomicWrite(change.file, await fs.readFile(change.backup, 'utf8'));
      else await fs.rm(change.file);
    }
    if (conflicts.length) throw new Error('配置在操作期间被其他程序修改，已保留现场。恢复记录：' + this.id);
  }
}
