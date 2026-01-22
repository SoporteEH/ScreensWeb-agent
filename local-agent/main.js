const { app, BrowserWindow, screen, ipcMain, shell, session } = require('electron');
const path = require('path');
const fs = require('fs').promises;

const { log } = require('./utils/logConfig');
const encryption = require('./utils/encryption');
const NetworkMonitor = require('./services/network');

/**
 * HARDWARE & PERFORMANCE OPTIMIZATIONS
 */
app.commandLine.appendSwitch('js-flags', '--expose-gc');

log.info('Screens starting (Standalone Monolith Mode)...');

// Project configurations and constants
const {
    CONFIG_DIR,
    STATE_FILE_PATH,
    CONTENT_DIR,
    CREDENTIALS_FILE_PATH,
    SETTINGS_FILE_PATH,
    CONSTANTS,
    AGENT_VERSION,
} = require('./config/constants');

// Service imports
const { buildDisplayMap, restoreLastState, loadLastState, saveCurrentState } = require('./services/state');
const { configureGpu, configureMemory, registerGpuCrashHandlers } = require('./services/gpu');
const { getGpuStatus } = require('./services/gpuCheck');
const { createTray, openControlWindow } = require('./services/tray');
const commandHandlers = require('./handlers/commands');

// App state management
const managedWindows = new Map();
const identifyWindows = new Map();
const retryManager = new Map();
const hardwareIdToDisplayMap = new Map();
const autoRefreshTimers = new Map();
let screenChangeTimeout;

// Initialize command handlers with internal context
commandHandlers.initializeHandlers({
    managedWindows,
    identifyWindows,
    retryManager,
    hardwareIdToDisplayMap,
    autoRefreshTimers,
    saveCurrentState,
    handleShowUrl: (cmd) => commandHandlers.handleShowUrl(cmd)
});

const { handleShowUrl, handleCloseScreen, handleIdentifyScreen, handleRecoverScreen } = commandHandlers;

// Initialize Network Monitor
const networkMonitor = new NetworkMonitor({
    managedWindows,
    retryManager,
    handleShowUrl,
    hardwareIdToDisplayMap
});

networkMonitor.on('recover-screen', (screenId) => {
    handleRecoverScreen(screenId);
});

/**
 * IPC HANDLERS - App Lifecycle & System Actions
 */
ipcMain.on('agent-action', (event, { action }) => {
    log.info(`[IPC]: Accion: ${action}`);
    switch (action) {
        case 'restart':
        case 'restart-agent':
            app.relaunch();
            app.exit(0);
            break;
        case 'quit':
        case 'quit-agent':
            app.isQuitting = true;
            app.quit();
            break;
        case 'open-control':
            openControlWindow(AGENT_VERSION);
            break;
        case 'open-logs':
            shell.showItemInFolder(log.transports.file.getFile().path);
            break;
        case 'update':
            log.info('[UPDATE]: Iniciando busqueda de actualizaciones (Manual)...');
            break;
    }
});

ipcMain.on('open-display-settings', () => {
    require('child_process').exec('start ms-settings:display');
});

ipcMain.handle('get-app-version', () => AGENT_VERSION);
ipcMain.handle('get-gpu-status', (event, options) => getGpuStatus(options));

/**
 * IPC HANDLERS - Display & Content Management
 */
ipcMain.handle('get-screens', async () => {
    const screens = [];
    const lastState = await loadLastState();
    for (const [screenId, display] of hardwareIdToDisplayMap.entries()) {
        const idKey = String(screenId);
        const stateData = lastState[idKey] || {};
        const window = managedWindows.get(idKey);
        screens.push({
            id: idKey,
            width: display.bounds.width,
            height: display.bounds.height,
            hasContent: !!window && !window.isDestroyed(),
            url: stateData.url || null,
            contentName: stateData.contentName || null,
            credentials: stateData.credentials || null,
            refreshInterval: stateData.refreshInterval || 0
        });
    }
    return screens;
});

ipcMain.on('send-url-to-screen', (event, data) => {
    log.info(`[IPC]: send-url-to-screen - Pantalla ${data.screenId}`);
    handleShowUrl({
        action: 'show_url',
        screenIndex: String(data.screenId),
        url: data.url,
        credentials: data.credentials || null,
        refreshInterval: data.refreshInterval || 0,
        contentName: data.contentName || null,
        silent: true
    });
});

ipcMain.on('refresh-screen', (event, screenId) => {
    const win = managedWindows.get(String(screenId));
    if (win && !win.isDestroyed()) win.webContents.reload();
});

ipcMain.on('close-screen', (event, screenId) => {
    handleCloseScreen({ action: 'close_screen', screenIndex: String(screenId), silent: true });
});

ipcMain.on('identify-screen', (event, screenId) => {
    handleIdentifyScreen({ action: 'identify_screen', screenIndex: String(screenId), identifierText: `Pantalla ${screenId}` });
});

ipcMain.handle('browse-local-content', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog({
        title: 'Seleccionar contenido local',
        defaultPath: CONTENT_DIR,
        filters: [{ name: 'Web/Media', extensions: ['html', 'htm', 'jpg', 'png', 'mp4', 'webm'] }],
        properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const fileName = path.basename(result.filePaths[0]);
    return { fileName, localUrl: `local:${fileName}` };
});

ipcMain.handle('get-presets', async () => {
    try {
        const presetsPath = path.join(__dirname, 'config', 'presets.json');
        try {
            await fs.access(presetsPath);
            const data = await fs.readFile(presetsPath, 'utf8');
            return JSON.parse(data);
        } catch {
            return [];
        }
    } catch (e) { log.error('Error presets:', e); }
    return [];
});

ipcMain.handle('get-credential', async (event, key) => {
    try {
        try {
            await fs.access(CREDENTIALS_FILE_PATH);
            const data = await fs.readFile(CREDENTIALS_FILE_PATH, 'utf8');
            const creds = JSON.parse(data);

            if (!creds[key]) return null;

            // If encrypted, decrypt
            if (creds[key].encrypted) {
                try {
                    return encryption.decrypt(creds[key]);
                } catch (err) {
                    log.error('[SECURITY]: Failed to decrypt credential, may be corrupted:', err.message);
                    return null;
                }
            }

            // Legacy plaintext - return as-is (will be encrypted on next save)
            log.warn(`[SECURITY]: Credential '${key}' is in plaintext, will be encrypted on next save`);
            return creds[key];
        } catch {
            return null;
        }
    } catch (e) {
        log.error('[CREDENTIAL]: Error reading credential:', e);
    }
    return null;
});

ipcMain.handle('save-credential', async (event, key, value) => {
    try {
        let data = {};
        try {
            await fs.access(CREDENTIALS_FILE_PATH);
            const content = await fs.readFile(CREDENTIALS_FILE_PATH, 'utf8');
            data = JSON.parse(content);
        } catch (e) { /* ignore if not exists/corrupt */ }

        // Encrypt credential before saving
        try {
            data[key] = encryption.encrypt(value);
            log.info(`[SECURITY]: Credential '${key}' encrypted and saved`);
        } catch (encErr) {
            log.error('[SECURITY]: Encryption failed, saving as plaintext (fallback):', encErr.message);
            data[key] = value; // Fallback to plaintext if encryption fails
        }

        const dir = path.dirname(CREDENTIALS_FILE_PATH);
        try {
            await fs.access(dir);
        } catch {
            await fs.mkdir(dir, { recursive: true });
        }
        await fs.writeFile(CREDENTIALS_FILE_PATH, JSON.stringify(data, null, 2));
        return true;
    } catch (e) {
        log.error('[CREDENTIAL]: Error saving credential:', e);
        return false;
    }
});

ipcMain.handle('get-settings', async () => {
    try {
        try {
            await fs.access(SETTINGS_FILE_PATH);
            const data = await fs.readFile(SETTINGS_FILE_PATH, 'utf8');
            return JSON.parse(data);
        } catch {
            return {};
        }
    } catch (e) { log.error('Error settings:', e); }
    return {};
});

ipcMain.handle('save-settings', async (event, settings) => {
    try {
        const dir = path.dirname(SETTINGS_FILE_PATH);
        try {
            await fs.access(dir);
        } catch {
            await fs.mkdir(dir, { recursive: true });
        }
        await fs.writeFile(SETTINGS_FILE_PATH, JSON.stringify(settings, null, 2));
        return true;
    } catch (e) {
        log.error('Error saving settings:', e);
        return false;
    }
});

/**
 * DISPLAY MANAGEMENT
 */
function onScreenChange() {
    if (screenChangeTimeout) clearTimeout(screenChangeTimeout);
    screenChangeTimeout = setTimeout(async () => {
        log.info('[DISPLAY]: Cambio detectado, re-mapeando pantallas...');
        await buildDisplayMap(hardwareIdToDisplayMap);

        const controlWindow = require('./services/tray').getControlWindow?.();
        if (controlWindow && !controlWindow.isDestroyed()) {
            controlWindow.webContents.send('screens-changed');
        }
    }, CONSTANTS.SCREEN_DEBOUNCE_MS);
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        openControlWindow(AGENT_VERSION);
    });
}

configureGpu();
configureMemory();
registerGpuCrashHandlers();

if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true, path: app.getPath('exe'), args: ['--hidden'] });
}

/**
 * APP STARTUP
 */
app.whenReady().then(async () => {
    log.info('[INIT]: Screens Standalone Ready.');
    createTray(AGENT_VERSION);
    await buildDisplayMap(hardwareIdToDisplayMap);

    session.defaultSession.clearCache().then(() => {
        log.info('[MEMORY]: Cache HTTP de inicio limpiada.');
    }).catch(() => { });
    networkMonitor.start(5000);
    await restoreLastState(hardwareIdToDisplayMap, handleShowUrl);

    screen.on('display-added', onScreenChange);
    screen.on('display-removed', onScreenChange);
    screen.on('display-metrics-changed', onScreenChange);

    log.info('[INIT]: Arranque completado.');
});

/**
 * PERIODIC MAINTENANCE
 */
setInterval(() => {
    if (global.gc) {
        global.gc();
        log.info('[MEMORY]: GC Manual ejecutado');
    }
}, CONSTANTS.GC_INTERVAL_MS || 4 * 60 * 60 * 1000);

setInterval(() => {
    managedWindows.forEach(win => {
        if (win && !win.isDestroyed()) win.webContents.session.clearCache().catch(() => { });
    });
}, 60 * 60 * 1000);

app.on('window-all-closed', () => {
    // Keep app running in tray even if control panel is closed
});
