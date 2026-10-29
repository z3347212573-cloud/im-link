import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const base = path.resolve('node_modules/electron');
const { version } = JSON.parse(await fs.readFile(path.join(base, 'package.json'), 'utf8'));
const file = 'electron-v' + version + '-win32-x64.zip';
const checksums = JSON.parse(await fs.readFile(path.join(base, 'checksums.json'), 'utf8'));
let data;
for (const prefix of [
  ...(process.env.IM_LINK_ELECTRON_OFFICIAL_FIRST ? ['https://github.com/electron/electron/releases/download/v' + version + '/'] : []),
  'https://registry.npmmirror.com/-/binary/electron/' + version + '/',
  'https://npmmirror.com/mirrors/electron/' + version + '/',
  'https://github.com/electron/electron/releases/download/v' + version + '/',
]) {
  try {
    const response = await fetch(prefix + file, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) { console.log(new URL(prefix).hostname + ': HTTP ' + response.status); continue; }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(buffer).digest('hex') !== checksums[file]) throw new Error('checksum');
    data = buffer;
    console.log('Electron 下载完成并通过官方 SHA-256 校验。');
    break;
  } catch (error) {
    const reason = String(error.cause?.code || error.code || error.name || 'download-failed').replace(/[^A-Za-z0-9_-]/g, '');
    console.log(new URL(prefix).hostname + ': 下载未成功或校验未通过（' + reason + '）。');
  }
}
if (!data) { process.exitCode = 1; }
else {
  await fs.mkdir('.artifacts', { recursive: true });
  const zip = path.resolve('.artifacts', file);
  await fs.writeFile(zip, data);
  const { extract } = require('@electron-internal/extract-zip');
  await extract(zip, { dir: path.join(base, 'dist') });
  await fs.writeFile(path.join(base, 'path.txt'), 'electron.exe');
}
