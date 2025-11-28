const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    onSetIdentifier: (callback) => ipcRenderer.on('set-identifier', (event, text) => callback(text))
});