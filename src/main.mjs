import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dataRoot } from './core/model.mjs';
import { Manager } from './core/manager.mjs';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
let window;
let manager;
const root = dataRoot();
if (process.env.IM_LINK_SMOKE && !process.env.IM_LINK_HOME) throw new Error('桌面测试必须使用隔离的数据目录。');
app.setName('IM Link');
app.setPath('userData', path.join(root, 'desktop'));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(async () => {
  manager = new Manager(root, { home: process.env.IM_LINK_SOURCE_HOME });
  await manager.scan();
  ipcMain.handle('im-link:invoke', async (event, method, input = {}) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无效的页面请求。');
    const actions = {
      snapshot: () => manager.snapshot(), scan: () => manager.scan(),
      save: () => manager.save(input), bind: () => manager.bind(input.id, input.profileId),
      unbind: () => manager.unbind(input.id), remove: () => manager.remove(input.id),
      update: () => manager.updateChannel(input.id, input),
      check: () => manager.check(input.id), import: () => manager.importFinding(input.id),
      addProfile: () => manager.addProfile(input),
      folder: async () => {
        const selected = await dialog.showOpenDialog(window, { properties: ['openDirectory'], title: '选择文件夹' });
        return selected.canceled ? null : selected.filePaths[0];
      },
      openData: () => shell.openPath(root),
      docs: () => shell.openExternal('https://open.feishu.cn/document/home/develop-a-bot-in-5-minutes/create-an-app'),
    };
    if (!Object.hasOwn(actions, method)) return { ok: false, error: '不支持这个操作。' };
    try { return { ok: true, value: await actions[method]() }; }
    catch (error) {
      const message = error instanceof SyntaxError ? '配置格式无效，请检查后重试；原文件没有被覆盖。' : error.message;
      return { ok: false, error: String(message || '操作失败，请重试。').replace(/sk-[A-Za-z0-9_-]+/g, '[隐藏]').slice(0, 450) };
    }
  });
  const create = async () => {
    window = new BrowserWindow({
      width: 1280, height: 850, minWidth: 940, minHeight: 650,
      title: '接线台 · IM Link', backgroundColor: '#eef2f6',
      show: !process.env.IM_LINK_SMOKE,
      webPreferences: { preload: path.join(appRoot, 'src/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    window.removeMenu();
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    await window.loadFile(path.join(appRoot, 'src/ui/index.html'));
    if (process.env.IM_LINK_SMOKE) {
      try {
        const { smoke } = await import('../tools/smoke.mjs');
        await smoke(window, manager);
        app.exit(0);
      } catch (error) { console.error(error); app.exit(1); }
    }
  };
  await create();
  app.on('activate', async () => { if (BrowserWindow.getAllWindows().length === 0) await create(); });
  app.on('window-all-closed', () => app.quit());
  }).catch((error) => {
    console.error('应用启动失败：', error.message);
    if (!process.env.IM_LINK_SMOKE) dialog.showErrorBox('接线台无法启动', '本机数据未能读取。请检查 ' + root + ' 中的配置格式或访问权限。');
    app.exit(1);
  });
}
