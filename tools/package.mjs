import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const dist = path.join(path.dirname(require.resolve('electron/package.json')), 'dist');
const root = path.resolve('release', 'IM-Link-0.1.0-' + process.platform + '-' + process.arch);
await fs.mkdir(root, { recursive: true });
await fs.cp(dist, root, { recursive: true });
const resources = process.platform === 'darwin' ? path.join(root, 'Electron.app/Contents/Resources') : path.join(root, 'resources');
const app = path.join(resources, 'app');
await fs.mkdir(app, { recursive: true });
for (const entry of ['src', 'tools', 'docs', 'README.md', 'package.json', 'package-lock.json']) {
  await fs.cp(path.resolve(entry), path.join(app, entry), { recursive: true });
}
await fs.cp('node_modules', path.join(app, 'node_modules'), {
  recursive: true, dereference: true,
  filter: (source) => !/node_modules[\\/](electron|@electron|@electron-internal)([\\/]|$)/.test(source),
});
await fs.copyFile(process.execPath, path.join(resources, process.platform === 'win32' ? 'node.exe' : 'node'));
if (process.platform === 'darwin') await fs.chmod(path.join(resources, 'node'), 0o755);
if (process.platform === 'win32') {
  await fs.copyFile(path.join(root, 'electron.exe'), path.join(root, 'IM Link.exe'));
  await fs.rm(path.join(root, 'electron.exe'));
}
await fs.writeFile(path.join(root, 'build-info.json'), JSON.stringify({
  version: '0.1.0', platform: process.platform, arch: process.arch, node: process.version,
  electron: JSON.parse(await fs.readFile(path.resolve('node_modules/electron/package.json'), 'utf8')).version,
  at: new Date().toISOString(), stage: 'development',
}, null, 2));
console.log(root);
