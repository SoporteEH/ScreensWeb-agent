const { app, BrowserWindow, screen, ipcMain, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { ElectronBlocker, parseFilters } = require('@cliqz/adblocker-electron');
const fetch = require('cross-fetch');
const { log } = require('./utils/logConfig');

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
const NetworkMonitor = require('./services/network');

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
            // Logic for update check would go here; for now, we just log it.
            break;
    }
});

ipcMain.handle('get-app-version', () => AGENT_VERSION);
ipcMain.handle('get-gpu-status', () => getGpuStatus());

/**
 * IPC HANDLERS - Display & Content Management
 */
ipcMain.handle('get-screens', () => {
    const screens = [];
    const lastState = loadLastState();
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

ipcMain.handle('get-presets', () => {
    try {
        const presetsPath = path.join(__dirname, 'config', 'presets.json');
        if (fs.existsSync(presetsPath)) return JSON.parse(fs.readFileSync(presetsPath, 'utf8'));
    } catch (e) { log.error('Error presets:', e); }
    return [];
});

ipcMain.handle('get-credential', (event, key) => {
    try {
        if (fs.existsSync(CREDENTIALS_FILE_PATH)) {
            const data = JSON.parse(fs.readFileSync(CREDENTIALS_FILE_PATH, 'utf8'));
            return data[key] || null;
        }
    } catch (e) { log.error('Error creds:', e); }
    return null;
});

ipcMain.handle('save-credential', (event, key, value) => {
    try {
        let data = {};
        if (fs.existsSync(CREDENTIALS_FILE_PATH)) {
            data = JSON.parse(fs.readFileSync(CREDENTIALS_FILE_PATH, 'utf8'));
        }
        data[key] = value;
        const dir = path.dirname(CREDENTIALS_FILE_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CREDENTIALS_FILE_PATH, JSON.stringify(data, null, 2));
        return true;
    } catch (e) { log.error('Error saving creds:', e); return false; }
});

ipcMain.handle('get-settings', () => {
    try {
        if (fs.existsSync(SETTINGS_FILE_PATH)) {
            return JSON.parse(fs.readFileSync(SETTINGS_FILE_PATH, 'utf8'));
        }
    } catch (e) { log.error('Error settings:', e); }
    return {};
});

ipcMain.handle('save-settings', (event, settings) => {
    try {
        const dir = path.dirname(SETTINGS_FILE_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(SETTINGS_FILE_PATH, JSON.stringify(settings, null, 2));
        return true;
    } catch (e) {
        log.error('Error saving settings:', e);
        return false;
    }
});

/**
 * DISPLAY MANAGEMENT (HOT-PLUG)
 * Debounced refresh when monitors are connected/disconnected.
 */
function onScreenChange() {
    if (screenChangeTimeout) clearTimeout(screenChangeTimeout);
    screenChangeTimeout = setTimeout(async () => {
        log.info('[DISPLAY]: Cambio detectado, re-mapeando pantallas...');
        await buildDisplayMap(hardwareIdToDisplayMap);

        // Notify control panel to perform a structural refresh
        const controlWindow = require('./services/tray').getControlWindow?.();
        if (controlWindow && !controlWindow.isDestroyed()) {
            controlWindow.webContents.send('screens-changed');
        }
    }, CONSTANTS.SCREEN_DEBOUNCE_MS);
}

// Ensure single instance and focus control window on second launch
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        openControlWindow(AGENT_VERSION);
    });
}

// Initial system configurations
configureGpu();
configureMemory();
registerGpuCrashHandlers();

if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true, path: app.getPath('exe'), args: ['--hidden'] });
}

/**
 * MAIN APP STARTUP
 */
app.whenReady().then(async () => {
    log.info('[INIT]: Screens Standalone Ready.');

    // Phase 1: Immediate UI Availability
    createTray(AGENT_VERSION);
    await buildDisplayMap(hardwareIdToDisplayMap);

    // Phase 2: Background Optimizations (Staggered to prevent UI hang)
    setTimeout(async () => {
        try {
            // 1. Initial Cache Clear
            await session.defaultSession.clearCache();
            log.info('[MEMORY]: Cache HTTP de inicio limpiada.');

            // 2. Optimized Adblocker Load
            let blocker;
            const { ADBLOCK_CACHE_PATH } = require('./config/constants');

            if (fs.existsSync(ADBLOCK_CACHE_PATH)) {
                log.info('[ADBLOCK]: Cargando motor desde cache...');
                const buffer = fs.readFileSync(ADBLOCK_CACHE_PATH);
                blocker = ElectronBlocker.deserialize(buffer);
            } else {
                log.info('[ADBLOCK]: Inicializando nuevo motor (primera vez)...');
                blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch);

                // Add whitelist before caching
                const { networkFilters, cosmeticFilters, preprocessors } = parseFilters('@@||bannerflow.net^');
                blocker.update({
                    newNetworkFilters: networkFilters,
                    newCosmeticFilters: cosmeticFilters,
                    newPreprocessors: preprocessors
                });

                // Save to cache for next boot
                const buffer = blocker.serialize();
                fs.writeFileSync(ADBLOCK_CACHE_PATH, buffer);
                log.info('[ADBLOCK]: Motor serializado y guardado en cache.');
            }

            blocker.enableBlockingInSession(session.defaultSession);
            log.info('[ADBLOCK]: Filtros de publicidad activados.');

        } catch (err) {
            log.error('[INIT]: Error en optimizaciones de fondo:', err);
        }
    }, 100);

    // Phase 3: Secondary Services
    networkMonitor.start(5000);
    restoreLastState(hardwareIdToDisplayMap, handleShowUrl);

    screen.on('display-added', onScreenChange);
    screen.on('display-removed', onScreenChange);

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

// Flush caches to prevent disk/RAM bloat over time
setInterval(() => {
    managedWindows.forEach(win => {
        if (win && !win.isDestroyed()) win.webContents.session.clearCache().catch(() => { });
    });
}, 60 * 60 * 1000);

app.on('window-all-closed', () => {
    // Keep app running in tray even if control panel is closed
});
