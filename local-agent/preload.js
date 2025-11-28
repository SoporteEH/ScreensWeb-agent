const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    onDeviceId: (callback) => ipcRenderer.on('device-id', (event, ...args) => callback(...args))
});