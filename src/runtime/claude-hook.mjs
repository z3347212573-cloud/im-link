import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicWrite, hash } from '../core/files.mjs';
import { stateStore } from '../core/model.mjs';

// Called by native SessionStart/SessionEnd hooks. Does not rewrite the claude command.
async function main() {
  if (process.env.IM_LINK_CHILD === '1') return;
  const args = process.argv.slice(2);
  const value = (key) => args[args.indexOf(key) + 1];
  const root = value('--home'), profileId = value('--profile'), event = value('--event');
  if (!root || !profileId) return;
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 1048576) throw new Error('hook input too large');
  }
  const payload = JSON.parse(input || '{}');
  if (!payload.session_id) return;
  if (process.env.IM_LINK_HOOK_PROBE === '1') {
    await atomicWrite(path.join(root, 'probes', hash(payload.session_id) + '-' + event + '.json'),
      JSON.stringify({ event, parentPid: process.ppid, sessionId: payload.session_id, at: Date.now() }));
  }
  const lease = path.join(root, 'hosts', profileId, hash(payload.session_id) + '.lease.json');
  if (event === 'SessionEnd') { await fs.rm(lease, { force: true }); return; }
  const state = await stateStore(root).read();
  if (!state.channels.some((channel) => channel.binding === profileId || channel.pending?.profileId === profileId)) return;
  await atomicWrite(lease, JSON.stringify({ pid: process.ppid, sessionId: payload.session_id, at: Date.now() }));
  if (process.env.IM_LINK_HOOK_PROBE === '1') return;
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('./host.mjs', import.meta.url)), root, profileId,
  ], { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, IM_LINK_CHILD: '1' } });
  child.on('error', () => {});
  child.unref();
}
try { await main(); }
catch { process.stderr.write('IM Link 渠道组件未能启动；请在管理工具中检查接入。\n'); }
