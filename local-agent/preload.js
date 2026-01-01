const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    // Para la ventana de identificación
    onDeviceId: (callback) => ipcRenderer.on('device-id', (event, ...args) => callback(...args)),

    // Para el panel de control
    onAgentInfo: (callback) => ipcRenderer.on('agent-info', (event, ...args) => callback(...args)),

    sendAction: (action, data) => ipcRenderer.send('agent-action', { action, data })
});