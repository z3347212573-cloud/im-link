import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
let failures = 0;
async function walk(root) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (['node_modules', 'release', '.artifacts', '.git'].includes(entry.name)) continue;
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (/\.(mjs|cjs)$/.test(file)) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status !== 0) { process.stderr.write(result.stderr); failures++; }
    }
  }
}
await walk('.');
console.log(failures ? String(failures) + ' 个语法错误' : '所有 JavaScript 文件语法检查通过');
process.exitCode = failures ? 1 : 0;
