const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    // Device identification (Signage mode)
    onDeviceId: (callback) => ipcRenderer.on('device-id', (event, ...args) => callback(...args)),

    // Agent status and versioning
    onAgentInfo: (callback) => ipcRenderer.on('agent-info', (event, ...args) => callback(...args)),
    onUpdateStatus: (callback) => ipcRenderer.on('update-status', (event, ...args) => callback(...args)),

    // Core agent commands (restart, quit, etc.)
    sendAction: (action, data) => ipcRenderer.send('agent-action', { action, data }),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),

    // Window controls for the frameless UI
    minimizeWindow: () => ipcRenderer.send('window-control', 'minimize'),
    closeWindow: () => ipcRenderer.send('window-control', 'close'),

    // Display management APIs
    getScreens: () => ipcRenderer.invoke('get-screens'),
    sendUrlToScreen: (screenId, url, options = {}) => {
        ipcRenderer.send('send-url-to-screen', {
            screenId,
            url,
            credentials: options.credentials || null,
            refreshInterval: options.refreshInterval || 0,
            contentName: options.contentName || null
        });
    },
    refreshScreen: (screenId) => ipcRenderer.send('refresh-screen', screenId),
    closeScreen: (screenId) => ipcRenderer.send('close-screen', screenId),
    identifyScreen: (screenId) => ipcRenderer.send('identify-screen', screenId),

    // Configuration and presets
    getPresets: () => ipcRenderer.invoke('get-presets'),
    browseLocalContent: () => ipcRenderer.invoke('browse-local-content'),
    getGpuStatus: (options) => ipcRenderer.invoke('get-gpu-status', options),

    // Credential persistence
    getCredential: (key) => ipcRenderer.invoke('get-credential', key),
    saveCredential: (key, value) => ipcRenderer.invoke('save-credential', key, value),

    // General settings (Station Name)
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

    // Event listeners
    onScreensChanged: (callback) => ipcRenderer.on('screens-changed', (event, screens) => callback(screens))
});
