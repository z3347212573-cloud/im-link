const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let state = { profiles: [], channels: [], findings: [], events: [] };
let view = 'channels', selected = null, step = 0, actionHandler;
let toastTimer;
let mutationGeneration = 0, mutations = 0;

async function call(method, input) {
  const changesState = !['snapshot', 'folder', 'docs', 'openData'].includes(method);
  if (changesState) { mutationGeneration++; mutations++; }
  try {
    const result = await window.imLink.invoke(method, input);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  } finally { if (changesState) mutations--; }
}
function toast(message, error = false) {
  const el = $('#toast'); el.textContent = message; el.className = 'toast' + (error ? ' error' : ''); el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 6500);
}
function profileName(profile) {
  if (!profile) return '尚未绑定';
  const base = profile.agent === 'dsh' ? 'DSH' : 'Claude Code';
  return state.profiles.filter((item) => item.agent === profile.agent).length > 1 ? base + ' · ' + profile.label : base;
}
function status(channel) {
  if (channel.pending) return ['等待任务结束', 'wait'];
  if (!channel.binding) return ['未绑定', ''];
  if (channel.runtime?.status === 'error') return ['接入异常', 'error'];
  if (channel.runtime?.busy) return ['任务处理中', 'ok'];
  if (channel.runtime?.status === 'listening') return channel.verifiedAt ? ['已验证接通', 'ok'] : ['等待首条消息', 'wait'];
  return ['等待重开 Agent', 'wait'];
}
const tag = (label, kind = '') => '<span class="tag ' + kind + '">' + escape(label) + '</span>';
const date = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未验证';
function profileOptions(current = '') {
  return '<option value="">暂不绑定，先保存渠道</option>' + state.profiles.map((profile) =>
    '<option value="' + escape(profile.id) + '"' + (profile.id === current ? ' selected' : '') + (!profile.installed ? ' disabled' : '') + '>' +
    escape(profileName(profile)) + (!profile.installed ? '（尚未发现配置）' : '') + '</option>').join('');
}
function render() {
  $('#channel-count').textContent = state.channels.length;
  $('#platform').textContent = state.platform === 'win32' ? 'Windows · 本机' : 'macOS · 本机';
  $('#breadcrumb').textContent = ({ channels: '渠道', agents: 'Agent', events: '操作记录' })[view];
  $$('.nav').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  if (view === 'channels') channelsView();
  else if (view === 'agents') agentsView();
  else eventsView();
}
function channelsView() {
  const finding = state.findings.filter((item) => !state.channels.some((channel) => channel.importedFrom === item.id));
  const discovery = finding.length ? '<div class="discovery"><span class="symbol">⌁</span><div><strong>发现 ' + finding.length +
    ' 项已有渠道配置</strong><p>查看后选择导入，原有设置会先备份。</p></div><button class="text-button" data-action="findings">查看发现结果 →</button></div>' : '';
  $('#main').innerHTML = '<div class="page-header"><div><h1>渠道</h1><p>机器人与 Agent 的连接，都在这里。</p></div><div class="header-actions"><button class="button subtle" data-action="scan">↻ 扫描配置</button><button class="button primary" data-action="add">＋ 添加渠道</button></div></div>' +
    discovery + (state.scanErrors?.length ? '<div class="error-banner">有 ' + state.scanErrors.length + ' 套配置未能读取。原文件已保留，可在 Agent 页面检查位置。</div>' : '') +
    '<section class="work-surface"><div class="surface-header"><h3>全部渠道 <span class="surface-meta"> / ' + state.channels.length + '</span></h3>' +
    (state.channels.length ? '<input class="search" id="search" placeholder="搜索渠道名称" aria-label="搜索渠道名称">' : '<span class="surface-meta">首版 · 飞书私聊</span>') + '</div>' +
    (state.channels.length ? '<div class="table-head"><span>渠道</span><span>连接到</span><span>接入状态</span><span></span></div><div id="channel-rows">' + channelRows(state.channels) + '</div>' :
      '<div class="empty"><div class="empty-mark"><span>飞</span><span>◇</span></div><h3>接入你的第一个机器人</h3><p>填一次接入信息，选择一个 Agent。以后更换绑定，无需再从头配置。</p><button class="button primary" data-action="add">＋ 添加飞书渠道</button></div>') + '</section>' +
    (selected ? detail(state.channels.find((item) => item.id === selected)) : '') +
    '<div class="workspace-bottom"><section class="info-card"><h3>配置一次，照常使用</h3><p>由 Agent 侧扩展负责收发消息。配置完成后，你可以关闭接线台；各启动入口的覆盖能力需要逐项验证。</p><button class="text-button" data-view="agents">查看本机 Agent →</button></section><section class="info-card"><h3>每个私聊，一段独立会话</h3><p>发送 /new 开始新的会话。正在执行任务时，会先完成任务、回复结果，再新建并提示成功。</p></section></div>';
  $('#search')?.addEventListener('input', (event) => {
    const value = event.target.value.toLowerCase();
    $('#channel-rows').innerHTML = channelRows(state.channels.filter((channel) => channel.name.toLowerCase().includes(value))) || '<p class="no-results">没有匹配的渠道</p>';
  });
}
function channelRows(channels) {
  return channels.map((channel) => {
    const profile = state.profiles.find((item) => item.id === channel.binding);
    const [label, kind] = status(channel);
    return '<div class="channel-row' + (selected === channel.id ? ' selected' : '') + '" role="button" tabindex="0" data-channel="' + channel.id + '">' +
      '<div class="channel-name"><span class="app-icon feishu">飞</span><div><strong>' + escape(channel.name) + '</strong><small>飞书 · 私聊</small></div></div>' +
      '<div class="connection' + (!profile ? ' unbound' : '') + '"><span class="wire"></span><div><strong>' + escape(profileName(profile)) + '</strong><small>' + (profile ? '专属会话 · 文字接入' : '选择一个 Agent 开始配置') + '</small></div></div>' +
      tag(label, kind) + '<span class="row-arrow">›</span></div>';
  }).join('');
}
function detail(channel) {
  if (!channel) { selected = null; return ''; }
  const profile = state.profiles.find((item) => item.id === channel.binding);
  return '<section class="detail"><div class="detail-head"><h3>' + escape(channel.name) + '</h3><button class="quiet" data-action="deselect">收起 ×</button></div><dl class="detail-grid">' +
    '<div><dt>当前绑定</dt><dd>' + escape(profileName(profile)) + '</dd></div><div><dt>接入信息</dt><dd>' + escape(channel.appIdHint) + ' · 密钥已加密保存</dd></div><div><dt>最近通信验证</dt><dd>' + escape(date(channel.verifiedAt)) + '</dd></div>' +
    '<div><dt>默认工作文件夹</dt><dd class="path">' + escape(channel.cwd || '使用 Agent 的默认工作目录') + '</dd></div><div><dt>凭据校验</dt><dd>' + escape(date(channel.credentialsCheckedAt)) + '</dd></div><div><dt>配置备份</dt><dd class="path">' + escape(channel.backupId || '尚无变更') + '</dd></div></dl>' +
    '<div class="detail-actions"><button class="button primary" data-action="bind" data-id="' + channel.id + '"' + (channel.pending ? ' disabled' : '') + '>' + (channel.binding ? '更换 Agent' : '绑定 Agent') + '</button>' +
    '<button class="button subtle" data-action="edit" data-id="' + channel.id + '">编辑设置</button><button class="button subtle" data-action="check" data-id="' + channel.id + '">校验接入信息</button>' +
    '<button class="button subtle" data-action="unbind" data-id="' + channel.id + '"' + (!channel.binding || channel.pending ? ' disabled' : '') + '>解绑</button>' +
    '<button class="button danger" data-action="remove" data-id="' + channel.id + '"' + (channel.binding || channel.pending ? ' disabled' : '') + '>删除渠道</button></div>' +
    '<p class="detail-note">' + (channel.pending ? '正在等待现有任务结束。后续消息会排队，在切换完成后交给目标 Agent。' : channel.recoveryNote ? escape(channel.recoveryNote) : channel.runtime?.lastError ? escape(channel.runtime.lastError) : '配置保存或凭据有效，并不代表当前已经接通。请重开目标 Agent 后，在飞书私聊发送一条消息，完成请求与回复验证。') + '</p></section>';
}
function agentsView() {
  $('#main').innerHTML = '<div class="page-header"><div><h1>Agent</h1><p>识别本机设置，按需要连接你的机器人。</p></div><div class="header-actions"><button class="button subtle" data-action="scan">↻ 重新扫描</button><button class="button primary" data-action="addProfile">＋ 添加一套设置</button></div></div><div class="agent-grid">' +
    ['dsh', 'claude'].map((agent) => {
      const profiles = state.profiles.filter((item) => item.agent === agent);
      return '<section class="agent-card"><div class="agent-heading"><span class="app-icon ' + (agent === 'claude' ? 'claude-icon' : 'agent-icon') + '">' + (agent === 'dsh' ? 'D' : '✳') +
        '</span><div><h3>' + (agent === 'dsh' ? 'DSH' : 'Claude Code') + '</h3><p>' + profiles.length + ' 套设置 · ' + state.channels.filter((channel) => profiles.some((profile) => profile.id === channel.binding)).length + ' 个渠道</p></div></div>' +
        (profiles.length ? profiles.map((profile) => '<div class="profile-row"><div class="profile-title"><strong>' + escape(profile.label) + '</strong>' +
          tag(profile.installed ? '配置已发现' : '未发现配置', profile.installed ? '' : 'wait') + '</div><p>' + escape(profile.configPath) + '</p><p class="profile-note">渠道扩展：' +
          (profile.inspectionError ? '配置未能读取' : profile.hooksDisabled ? '生命周期钩子已禁用' : profile.extensionConfigured ? '已配置，等待 Agent 加载与验证' : '尚未配置') +
          '</p><p class="profile-note">已接渠道：' + escape(state.channels.filter((channel) => channel.binding === profile.id).map((channel) => channel.name).join('、') || '暂无') +
          '</p><p class="profile-note">' + escape(profile.note) + '</p></div>').join('') :
          '<p class="note">尚未发现本机配置。安装并运行 Agent 后重新扫描，或添加现有设置位置。</p>') + '</section>';
    }).join('') + '</div><div class="callout"><span>ⓘ</span><p>Claude Code 使用原生生命周期钩子，DSH 使用 Cordis 扩展注册。具体版本、IDE 和桌面入口的加载情况需实测；“配置已发现”不代表消息已接通。</p></div>';
}
function eventsView() {
  $('#main').innerHTML = '<div class="page-header"><div><h1>操作记录</h1><p>查看配置变更和恢复记录。这里不记录你的聊天内容与密钥。</p></div></div><section class="work-surface"><div class="surface-header"><h3>最近操作</h3><span class="surface-meta">最多保留 200 条</span></div>' +
    (state.events.length ? '<div class="events">' + state.events.map((event) => '<div class="event"><time class="event-time">' + escape(date(event.at)) + '</time><div><strong>' + escape(event.action) + '</strong><p>' + escape(event.detail) + '</p></div></div>').join('') + '</div>' : '<div class="empty"><h3>还没有配置变更</h3><p>添加渠道或更换绑定后，会在这里留下记录。</p></div>') + '</section>';
}
function wizardPage(next) {
  step = next;
  $$('.wizard-page').forEach((page) => { page.hidden = Number(page.dataset.page) !== step; });
  $$('.steps span').forEach((item) => { item.className = Number(item.dataset.step) === step ? 'current' : Number(item.dataset.step) < step ? 'complete' : ''; });
  $('#wizard-prev').textContent = step ? '← 上一步' : '取消';
  $('#wizard-next').textContent = step === 2 ? '保存并配置' : '下一步 →';
  $('#step-hint').textContent = ['已有应用可以直接下一步', '密钥仅在本机保存', '配置完成后按提示重开 Agent'][step];
  $('#wizard-error').textContent = '';
}
function openWizard() {
  $('#channel-form').reset();
  $('#channel-form').elements.appSecret.type = 'password';
  $('[data-action="toggleSecret"]').textContent = '显示';
  $('#profile-select').innerHTML = profileOptions();
  wizardPage(0); $('#wizard').showModal();
}
function actionDialog(title, content, submit, handler, danger = false) {
  $('#action-title').textContent = title; $('#action-content').innerHTML = content;
  $('#action-error').textContent = ''; $('#action-submit').textContent = submit;
  $('#action-submit').className = 'button ' + (danger ? 'danger' : 'primary');
  actionHandler = handler; $('#action-dialog').showModal();
}
async function chooseFolder(input) { const folder = await call('folder'); if (folder) input.value = folder; }
async function perform(action, element) {
  const id = element?.dataset.id;
  if (action === 'add') return openWizard();
  if (action === 'closeWizard') { $('#wizard').close(); $('#channel-form').reset(); return; }
  if (action === 'closeAction') return $('#action-dialog').close();
  if (action === 'deselect') { selected = null; return render(); }
  if (action === 'docs' || action === 'openData') return call(action);
  if (action === 'scan') { state = await call('scan'); render(); return toast('已扫描本机配置。'); }
  if (action === 'toggleSecret') {
    const input = $('#channel-form').elements.appSecret;
    input.type = input.type === 'password' ? 'text' : 'password'; element.textContent = input.type === 'password' ? '显示' : '隐藏'; return;
  }
  if (action === 'chooseChannelFolder') return chooseFolder($('#channel-form').elements.cwd);
  if (action === 'chooseActionFolder') return chooseFolder($('#action-form').elements.cwd || $('#action-form').elements.root);
  if (action === 'check') {
    element.disabled = true;
    try { const result = await call('check', { id }); state = result.snapshot; render(); toast(result.message); }
    finally { element.disabled = false; } return;
  }
  if (action === 'bind') {
    const channel = state.channels.find((item) => item.id === id);
    actionDialog(channel.binding ? '更换绑定的 Agent' : '绑定 Agent',
      '<p class="note">任务正在执行时会等待完成。切换后从空白会话开始，原来的记录保留。</p><label>选择 Agent 设置<select name="profileId">' + profileOptions(channel.binding) + '</select></label>',
      '保存绑定', async (form) => { if (!form.elements.profileId.value) throw new Error('请选择目标 Agent。'); state = await call('bind', { id, profileId: form.elements.profileId.value }); });
    return;
  }
  if (action === 'edit') {
    const channel = state.channels.find((item) => item.id === id);
    const disabled = channel.binding || channel.pending ? ' disabled' : '';
    actionDialog('编辑渠道设置', '<label>渠道名称<input name="name" value="' + escape(channel.name) + '" maxlength="80" required></label><label>默认工作文件夹<div class="folder-field"><input name="cwd" value="' + escape(channel.cwd) + '"><button type="button" class="button subtle" data-action="chooseActionFolder">选择</button></div></label>' +
      '<label>更新 App ID<span class="optional">留空保持现有值</span><input name="appId" placeholder="' + escape(channel.appIdHint) + '"' + disabled + ' autocomplete="off"></label>' +
      '<label>更新 App Secret<span class="optional">留空保持现有值</span><input name="appSecret" type="password" placeholder="输入新的密钥"' + disabled + ' autocomplete="new-password"><small>' +
      (disabled ? '更新接入信息前请先解绑，避免影响正在执行的任务。' : '仅更新你填写的值，继续在本机加密保存。') + '</small></label>',
      '保存设置', async (form) => { state = await call('update', { id, ...Object.fromEntries(new FormData(form)) }); });
    return;
  }
  if (action === 'unbind') {
    actionDialog('解绑这个渠道？', '<p class="note">等待正在执行的任务完成后停用接入。机器人信息和密钥会保留，以后可以重新绑定。</p>', '解绑', async () => { state = await call('unbind', { id }); });
    return;
  }
  if (action === 'remove') {
    actionDialog('删除这个渠道？', '<p class="note danger-copy">删除本工具保存的接入信息和密钥。Agent 历史记录保留，飞书后台应用由你自行管理。</p>', '删除渠道', async () => { state = await call('remove', { id }); selected = null; }, true);
    return;
  }
  if (action === 'addProfile') {
    actionDialog('添加一套 Agent 设置', '<label>Agent<select name="agent"><option value="dsh">DSH</option><option value="claude">Claude Code</option></select></label><label>设置名称<input name="label" placeholder="例如：工作项目"></label><label>配置文件夹<div class="folder-field"><input name="root" required placeholder="选择包含配置的文件夹"><button type="button" class="button subtle" data-action="chooseActionFolder">选择</button></div><small>DSH 选择 profile 文件夹；Claude Code 选择对应的配置目录。</small></label>',
      '添加设置', async (form) => { state = await call('addProfile', Object.fromEntries(new FormData(form))); });
    return;
  }
  if (action === 'findings') {
    actionDialog('发现的已有接入', '<p class="note">导入后由接线台管理，原插件会在补丁层停用。需要按提示重开 Agent，使旧接入退出后再接通新组件。</p>' +
      state.findings.map((item) => '<div class="finding"><strong>' + escape(item.name) + '</strong><p>' + escape(item.pluginName) + '<br>' + escape(item.configPath) + '</p><button type="button" class="button subtle" data-action="import" data-id="' + item.id + '">导入并接管</button></div>').join(''),
      '完成', async () => {});
    return;
  }
  if (action === 'import') {
    element.disabled = true;
    try { state = await call('import', { id }); $('#action-dialog').close(); selected = state.channels.at(-1)?.id; render(); toast('已导入。请按提示重开 Agent 后验证消息。'); }
    finally { element.disabled = false; }
  }
}
document.addEventListener('click', (event) => {
  const nav = event.target.closest('[data-view]');
  if (nav) { view = nav.dataset.view; render(); return; }
  const row = event.target.closest('[data-channel]');
  if (row) { selected = selected === row.dataset.channel ? null : row.dataset.channel; render(); return; }
  const button = event.target.closest('[data-action]');
  if (button) perform(button.dataset.action, button).catch((error) => {
    if ($('#action-dialog').open) $('#action-error').textContent = error.message;
    else toast(error.message, true);
  });
});
document.addEventListener('keydown', (event) => {
  if (event.target.matches('[data-channel]') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.target.click(); }
});
$('#wizard-prev').addEventListener('click', () => { if (step) wizardPage(step - 1); else $('#wizard').close(); });
$('#wizard-next').addEventListener('click', async () => {
  const button = $('#wizard-next'), form = $('#channel-form');
  if (step === 1 && (!form.elements.name.value.trim() || !form.elements.appId.value.trim() || !form.elements.appSecret.value.trim())) {
    $('#wizard-error').textContent = '请填写渠道名称、App ID 和 App Secret。'; return;
  }
  if (step < 2) { wizardPage(step + 1); return; }
  button.disabled = true; button.textContent = '正在保存…';
  try {
    state = await call('save', Object.fromEntries(new FormData(form)));
    selected = state.channels.at(-1)?.id; $('#wizard').close(); form.reset(); render();
    toast('已保存。绑定 Agent 后，请重开 Agent 并验证消息。');
  } catch (error) { $('#wizard-error').textContent = error.message; }
  finally { button.disabled = false; button.textContent = '保存并配置'; }
});
$('#channel-form').addEventListener('submit', (event) => event.preventDefault());
$('#wizard').addEventListener('close', () => $('#channel-form').reset());
$('#action-dialog').addEventListener('close', () => { $('#action-content').replaceChildren(); });
$('#action-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = $('#action-submit'); button.disabled = true;
  try { await actionHandler(event.currentTarget); $('#action-dialog').close(); render(); toast('操作已完成。'); }
  catch (error) { $('#action-error').textContent = error.message; }
  finally { button.disabled = false; }
});
async function refresh() {
  if (mutations) return;
  const generation = mutationGeneration;
  const value = await call('snapshot');
  if (generation !== mutationGeneration || mutations) return;
  state = value;
  if (!$('#wizard').open && !$('#action-dialog').open && document.activeElement?.id !== 'search') render();
}
$('#main').innerHTML = '<p class="loading">正在读取本机配置…</p>';
refresh().catch((error) => { $('#main').innerHTML = '<p class="error-banner">' + escape(error.message) + '</p>'; });
setInterval(() => refresh().catch(() => {}), 4000);
