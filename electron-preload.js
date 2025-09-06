// electron-preload.js
const { contextBridge, ipcRenderer } = require('electron');

// Экспорт API для renderer процесса
contextBridge.exposeInMainWorld('electronAPI', {
  // Добавьте необходимые методы
  minimize: () => ipcRenderer.invoke('window-minimize'),
  close: () => ipcRenderer.invoke('window-close')
});