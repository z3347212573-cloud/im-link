// Download through a public binary mirror, but trust only the hashes shipped by Electron.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
const base = path.resolve('node_modules/electron');
const { version } = JSON.parse(await fs.readFile(path.join(base, 'package.json'), 'utf8'));
const file = 'electron-v' + version + '-win32-x64.zip';
const checksums = JSON.parse(await fs.readFile(path.join(base, 'checksums.json'), 'utf8'));
const url = 'https://cdn.npmmirror.com/binaries/electron/' + version + '/' + file;
const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
const total = Number(head.headers.get('content-length'));
if (!head.ok || !total) throw new Error('无法读取运行环境大小。');
const root = path.resolve('.artifacts', 'electron-' + version + '-chunks');
await fs.mkdir(root, { recursive: true });
const size = 4 * 1024 * 1024, count = Math.ceil(total / size);
let next = 0, complete = 0;
async function worker() {
  while (next < count) {
    const index = next++, start = index * size, end = Math.min(total - 1, start + size - 1);
    const part = path.join(root, String(index) + '.part');
    if ((await fs.stat(part).catch(() => null))?.size !== end - start + 1) {
      let buffer;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(url + '?part=' + index, { headers: { Range: 'bytes=' + start + '-' + end }, signal: AbortSignal.timeout(30000) });
          if (response.status !== 206 || response.headers.get('content-range') !== 'bytes ' + start + '-' + end + '/' + total) throw new Error('range mismatch');
          buffer = Buffer.from(await response.arrayBuffer());
          if (buffer.length !== end - start + 1) throw new Error('short read');
          break;
        } catch { if (attempt === 2) throw new Error('分段下载失败：' + index); }
      }
      await fs.writeFile(part, buffer);
    }
    complete++;
    if (complete % 8 === 0 || complete === count) console.log('Electron 下载：' + complete + '/' + count);
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
const zip = path.resolve('.artifacts', file);
const output = await fs.open(zip, 'w'), digest = createHash('sha256');
try {
  for (let index = 0; index < count; index++) {
    const buffer = await fs.readFile(path.join(root, String(index) + '.part'));
    digest.update(buffer); await output.write(buffer);
  }
} finally { await output.close(); }
if (digest.digest('hex') !== checksums[file]) throw new Error('官方 SHA-256 校验未通过，未安装。');
console.log('官方 SHA-256 校验通过。');
const quote = (value) => "'" + value.replace(/'/g, "''") + "'";
const script = 'Expand-Archive -LiteralPath ' + quote(zip) + ' -DestinationPath ' + quote(path.join(base, 'dist')) + ' -Force';
await new Promise((resolve, reject) => {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' });
  child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('解压失败。')));
});
await fs.writeFile(path.join(base, 'path.txt'), 'electron.exe');
console.log('Electron ' + version + ' 已安装。');
