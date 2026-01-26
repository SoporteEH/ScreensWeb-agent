const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    // Identificación
    onDeviceId: (callback) => ipcRenderer.on('device-id', (event, ...args) => callback(...args)),

    // Panel de control
    onAgentInfo: (callback) => ipcRenderer.on('agent-info', (event, ...args) => callback(...args)),
    onUpdateStatus: (callback) => ipcRenderer.on('update-status', (event, ...args) => callback(...args)),

    sendAction: (action, data) => ipcRenderer.send('agent-action', { action, data }),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    minimizeWindow: () => ipcRenderer.send('window-control', 'minimize'),
    closeWindow: () => ipcRenderer.send('window-control', 'close'),
    send: (channel, data) => ipcRenderer.send(channel, data),
    on: (channel, func) => ipcRenderer.on(channel, (event, ...args) => func(...args))
});