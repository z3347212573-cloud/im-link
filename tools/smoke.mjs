import fs from 'node:fs/promises';
import path from 'node:path';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function smoke(window, manager) {
  const run = async (code) => {
    try { return await window.webContents.executeJavaScript('{' + code + '}', true); }
    catch { throw new Error('桌面测试脚本失败：' + code.slice(0, 100)); }
  };
  const assert = (value, message) => { if (!value) throw new Error(message); };
  await pause(700);
  assert(await run("document.querySelector('h1')?.textContent === '渠道'"), '首页没有加载');
  await run("document.querySelector('[data-action=add]').click()");
  assert(await run("document.querySelector('#wizard').open"), '添加渠道对话框未打开');
  await run("document.querySelector('#wizard-next').click()");
  await run("const f=document.querySelector('#channel-form'); f.elements.name.value='验收机器人'; f.elements.appId.value='cli_smoke123'; f.elements.appSecret.value='smoke-secret-not-production'; document.querySelector('#wizard-next').click()");
  await run("document.querySelector('#wizard-next').click()");
  await pause(1800);
  assert((await manager.snapshot()).channels.length === 1, '没有保存渠道');
  assert(await run("document.body.textContent.includes('验收机器人')"), '列表没有显示真实保存的渠道');
  assert(!await run("document.body.textContent.includes('smoke-secret-not-production')"), '页面泄露了密钥');
  await run("document.querySelector('[data-action=edit]').click()");
  await run("document.querySelector('#action-form').elements.name.value='已编辑机器人'; document.querySelector('#action-submit').click()");
  await pause(400);
  assert((await manager.snapshot()).channels[0].name === '已编辑机器人', '编辑没有持久保存');
  await pause(200);
  assert(await run("document.querySelector('.channel-name strong').textContent === '已编辑机器人'"), '编辑后界面没有更新');
  await run("document.querySelector('#toast').hidden=true");
  await run("document.querySelector('[data-action=bind]').click(); const s=document.querySelector('#action-form').elements.profileId; s.value=[...s.options].find(o=>o.value.startsWith('claude-')).value; document.querySelector('#action-submit').click()");
  await pause(1300);
  const bound = (await manager.snapshot()).channels[0];
  assert(bound.binding?.startsWith('claude-'), '界面绑定 Claude Code 失败');
  assert(bound.status === 'waiting_restart', '保存配置被错误标记为已接通');
  const profile = (await manager.snapshot()).profiles.find((item) => item.id === bound.binding);
  const configuration = JSON.parse(await fs.readFile(profile.configPath, 'utf8'));
  assert(configuration.fixtureField === 'preserve', '绑定覆盖了无关配置');
  assert(configuration.hooks.SessionStart[0].hooks[0].args.includes('--im-link'), '未写入原生启动钩子');
  const errors = await run("({overflow:document.documentElement.scrollWidth>innerWidth,dialogs:[...document.querySelectorAll('dialog[open]')].length})");
  assert(!errors.overflow, '窗口有横向溢出');
  await fs.mkdir('.artifacts', { recursive: true });
  await fs.writeFile(path.resolve('.artifacts/desktop-channels.png'), (await window.webContents.capturePage()).toPNG());
  await run("document.querySelector('[data-view=agents]').click()");
  await pause(200);
  assert(await run("document.body.textContent.includes('Claude Code')"), 'Agent 页面没有加载');
  await fs.writeFile(path.resolve('.artifacts/desktop-agents.png'), (await window.webContents.capturePage()).toPNG());
  await run("document.querySelector('[data-view=channels]').click(); document.querySelector('[data-action=bind]').click(); const s=document.querySelector('#action-form').elements.profileId; s.value=[...s.options].find(o=>o.value.startsWith('dsh-')).value; document.querySelector('#action-submit').click()");
  await pause(1300);
  assert((await manager.snapshot()).channels[0].binding.startsWith('dsh-'), '界面更换绑定失败');
  await run("document.querySelector('[data-action=unbind]').click(); document.querySelector('#action-submit').click()");
  await pause(600);
  assert((await manager.snapshot()).channels[0].binding === null, '解绑未生效');
  await run("document.querySelector('[data-action=remove]').click()");
  await run("document.querySelector('#action-submit').click()");
  await pause(400);
  assert((await manager.snapshot()).channels.length === 0, '删除渠道未生效');
  const encrypted = await fs.readFile(path.join(manager.root, 'credentials.enc.json'), 'utf8');
  assert(!encrypted.includes('smoke-secret-not-production'), '凭据存储出现明文');
  console.log('DESKTOP_SMOKE_PASS: 添加、加密保存、编辑、Claude 绑定、DSH 切换、解绑、删除、页面切换、无横向溢出。');
}
