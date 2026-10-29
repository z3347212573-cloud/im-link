import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { JsonStore, atomicWrite, withLock } from './files.mjs';

function command(program, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.resume();
    child.on('error', () => reject(new Error('无法访问系统凭据存储。')));
    child.on('exit', (code) => code === 0 ? resolve(out.trim()) : reject(new Error('系统凭据存储不可用，请解锁系统钥匙串后重试。')));
    child.stdin.end(input);
  });
}

export async function systemKey(root, platform = process.platform) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  return withLock(path.join(root, 'key-setup'), async () => {
    if (platform === 'win32') {
      const file = path.join(root, 'key.dpapi');
      let wrapped = await fs.readFile(file, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      const script = 'Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); ' +
        (wrapped
          ? '$r=[System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v),$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($r))'
          : '$r=[System.Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($v),$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($r))');
      const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
      if (wrapped) return Buffer.from(await command('powershell.exe', args, wrapped), 'base64');
      const key = randomBytes(32);
      wrapped = await command('powershell.exe', args, key.toString('base64'));
      await atomicWrite(file, wrapped);
      return key;
    }
    if (platform === 'darwin') {
      const service = 'im-link.' + Buffer.from(root).toString('base64url');
      const marker = path.join(root, 'keychain.ready');
      try {
        const key = await command('/usr/bin/security', ['find-generic-password', '-s', service, '-a', 'vault', '-w']);
        if (Buffer.from(key, 'base64').length !== 32) throw new Error('钥匙串密钥无效。');
        return Buffer.from(key, 'base64');
      } catch (error) {
        if (await fs.stat(marker).catch(() => null)) throw error;
        const key = randomBytes(32);
        await command('/usr/bin/security', ['add-generic-password', '-s', service, '-a', 'vault', '-w', key.toString('base64')]);
        await atomicWrite(marker, '系统钥匙串保存主密钥');
        return key;
      }
    }
    throw new Error('凭据加密目前支持 Windows DPAPI 和 macOS 钥匙串。');
  });
}

export class Vault {
  constructor(root, keyProvider = () => systemKey(root)) {
    this.store = new JsonStore(path.join(root, 'credentials.enc.json'), {});
    this.keyProvider = keyProvider;
  }
  async put(id, value) {
    const key = await this.keyProvider();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(id));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    await this.store.update((state) => {
      state[id] = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    });
  }
  async get(id) {
    const value = (await this.store.read())[id];
    if (!value) throw new Error('没有找到该渠道的接入信息。');
    const decipher = createDecipheriv('aes-256-gcm', await this.keyProvider(), Buffer.from(value.iv, 'base64'));
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8'));
  }
  async remove(id) { await this.store.update((state) => { delete state[id]; }); }
}
