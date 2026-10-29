const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('imLink', Object.freeze({
  invoke: (method, input) => ipcRenderer.invoke('im-link:invoke', method, input),
}));
