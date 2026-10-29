import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { discover } from '../src/core/discovery.mjs';
import { atomicWrite, hash } from '../src/core/files.mjs';
import { Manager } from '../src/core/manager.mjs';
import { Vault } from '../src/core/vault.mjs';
import { randomBytes } from 'node:crypto';

const artifacts = path.resolve('.artifacts');
await fs.mkdir(artifacts, { recursive: true });
const discovery = await discover();
const report = {
  date: new Date().toISOString(), platform: process.platform,
  profiles: discovery.profiles.map(({ id, agent, label, installed }) => ({ id, agent, label, installed })),
  findings: discovery.findings.map(({ name, pluginName }) => ({ name, pluginName })),
  failures: discovery.errors, realFeishu: '未验证：未导入或接管用户现有机器人',
  macOS: '未验证：当前主机为 Windows',
};
if (process.argv.includes('--hooks')) {
  const sandbox = await fs.mkdtemp(path.join(artifacts, 'hook-probe-'));
  const config = path.join(sandbox, 'claude');
  await fs.mkdir(config, { recursive: true });
  const manager = new Manager(sandbox, { vault: new Vault(sandbox, async () => randomBytes(32)), node: process.execPath });
  await manager.store.update((state) => {
    state.profiles.push({ id: 'claude-probe', agent: 'claude', root: config, configPath: path.join(config, 'settings.json') });
    state.channels.push({ id: 'probe', binding: null, revision: 0, name: 'Hook probe' });
  });
  // The probe's vault provider is stable across put/get.
  const key = randomBytes(32); manager.vault.keyProvider = async () => key;
  await manager.vault.put('probe', { appId: 'cli_probe', appSecret: 'not-a-real-credential' });
  await manager.bind('probe', 'claude-probe');
  const require = createRequire(import.meta.url);
  const binary = path.join(path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk-win32-x64/package.json')), 'claude.exe');
  const result = await new Promise((resolve) => {
    const child = spawn(binary, ['--init-only', '--setting-sources', 'user'], {
      cwd: sandbox, windowsHide: true,
      env: { ...process.env, CLAUDE_CONFIG_DIR: config, IM_LINK_HOOK_PROBE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let bytes = 0;
    child.stdout.on('data', (chunk) => { bytes += chunk.length; });
    child.stderr.on('data', (chunk) => { bytes += chunk.length; });
    const timeout = setTimeout(() => child.kill(), 30000);
    child.on('error', () => { clearTimeout(timeout); resolve({ exitCode: null, error: 'CLI 未能启动' }); });
    child.on('exit', (code) => { clearTimeout(timeout); resolve({ exitCode: code, outputBytes: bytes, cliPid: child.pid }); });
  });
  const events = await fs.readdir(path.join(sandbox, 'probes')).catch(() => []);
  const starts = events.filter((file) => file.endsWith('-SessionStart.json'));
  const start = starts.length ? JSON.parse(await fs.readFile(path.join(sandbox, 'probes', starts[0]), 'utf8')) : null;
  report.claudeHook = { ...result, sessionStartObserved: starts.length > 0, sessionEndObserved: events.some((file) => file.endsWith('-SessionEnd.json')), hookParentIsCli: start?.parentPid === result.cliPid, mode: '隔离用户级配置；init-only；不发送模型请求' };
}
await atomicWrite(path.join(artifacts, 'probe.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
