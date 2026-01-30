/**
 * ScreensWeb Local Agent
 * Orchestrator Main Process
 */

const { app, BrowserWindow, screen, net, ipcMain } = require('electron');
const { log } = require('./utils/logConfig');
const path = require('path');
const fs = require('fs');

// OPTIMIZATION: Manual GC
app.commandLine.appendSwitch('js-flags', '--expose-gc');

// 1. AUTO-UPDATER INITIALIZATION (CRITICAL)
try {
    const { configureUpdater, checkForUpdates } = require('./services/updater');
    configureUpdater();
    checkForUpdates();
} catch (updaterError) {
    log.error('Fatal: Failed to initialize auto-updater:', updaterError);
}

// GLOBAL STATE (Managed via context)
const context = {
    deviceId: null,
    agentToken: null,
    socket: null,
    isOnline: false,
    managedWindows: new Map(),
    identifyWindows: new Map(),
    retryManager: new Map(),
    hardwareIdToDisplayMap: new Map(),
    autoRefreshTimers: new Map(),
};

// 2. BOOTSTRAP
async function bootstrap() {
    try {
        const constants = require('./config/constants');
        const { loadConfig, saveConfig } = require('./utils/configManager');
        const { configureGpu, configureMemory, registerGpuCrashHandlers } = require('./services/gpu');
        const { registerIpcHandlers } = require('./handlers/ipc');
        const { startNormalMode, startProvisioningMode } = require('./services/agentModes');
        const { createTray } = require('./services/tray');
        const commandHandlers = require('./handlers/commands');
        const stateService = require('./services/state');
        const socketService = require('./services/socket');
        const deviceService = require('./services/device');
        const assetsService = require('./services/assets');

        // SINGLE INSTANCE LOCK
        const gotTheLock = app.requestSingleInstanceLock();
        if (!gotTheLock) { app.quit(); return; }

        // HARDWARE & MEMORY CONFIG
        configureGpu();
        configureMemory();
        registerGpuCrashHandlers();

        // AUTO-START CONFIG
        if (app.isPackaged) {
            app.setLoginItemSettings({
                openAtLogin: true,
                path: app.getPath('exe'),
                args: ['--hidden']
            });
        }

        // IPC HANDLERS
        registerIpcHandlers(constants.getServerUrl, constants.AGENT_VERSION);

        // COMMAND HANDLER INITIALIZATION
        context.isOnline = () => context.isOnline;
        context.saveCurrentState = stateService.saveCurrentState;
        context.handleShowUrl = (cmd, att) => commandHandlers.handleShowUrl(cmd, att);
        commandHandlers.initializeHandlers(context);

        // ENRICH CONTEXT WITH ACTIONS
        context.CONSTANTS = constants.CONSTANTS;
        context.setDeviceId = (id) => { context.deviceId = id; };
        context.setAgentToken = (token) => { context.agentToken = token; };
        context.registerDevice = () => deviceService.registerDevice(context.socket, context.deviceId, context.hardwareIdToDisplayMap);
        context.sendHeartbeat = () => socketService.sendHeartbeat(context.socket, Array.from(context.hardwareIdToDisplayMap.keys()));
        context.restoreAllContent = () => stateService.restoreAllContentImmediately(
            context.hardwareIdToDisplayMap,
            context.managedWindows,
            commandHandlers.handleShowUrl,
            commandHandlers.createContentWindow
        );

        // SOCKET CONNECTION WRAPPER
        context.connectSocket = (token) => {
            context.socket = socketService.connectToSocketServer(token, {
                onConnect: () => {
                    context.isOnline = true;
                    context.registerDevice();
                    assetsService.syncLocalAssets(context.agentToken);
                },
                onDisconnect: () => { context.isOnline = false; },
                onReconnect: () => {
                    context.isOnline = true;
                    context.registerDevice();
                    assetsService.syncLocalAssets(context.agentToken);
                    setTimeout(() => stateService.restoreLastState(context.hardwareIdToDisplayMap, commandHandlers.handleShowUrl), 1000);
                },
                onCommand: (command) => {
                    log.info('[SOCKET]: Comando recibido:', command);
                    const actions = {
                        'show_url': commandHandlers.handleShowUrl,
                        'close_screen': commandHandlers.handleCloseScreen,
                        'identify_screen': commandHandlers.handleIdentifyScreen,
                        'refresh_screen': commandHandlers.handleRefreshScreen,
                        'reboot_device': deviceService.handleRebootDevice,
                        'force_update': require('./services/updater').handleForceUpdate
                    };
                    if (actions[command.action]) actions[command.action](command);
                },
                onAssetsUpdated: () => assetsService.syncLocalAssets(context.agentToken),
                onForceReprovision: () => {
                    log.warn('[SOCKET]: Force-reprovision received.');
                    // ... same logic as before to clean config and relaunch
                    context.managedWindows.forEach(win => { if (win && !win.isDestroyed()) win.close(); });
                    try {
                        if (fs.existsSync(constants.CONFIG_FILE_PATH)) fs.unlinkSync(constants.CONFIG_FILE_PATH);
                        if (fs.existsSync(constants.STATE_FILE_PATH)) fs.unlinkSync(constants.STATE_FILE_PATH);
                    } catch (e) { log.error('Error unlinking config:', e); }
                    app.relaunch();
                    app.exit(0);
                }
            });
        };

        // NETWORK HANDLERS
        context.onNetworkOffline = () => {
            context.isOnline = false;
            const fallbackPath = `file://${path.join(__dirname, 'fallback.html')}`;
            const lastState = stateService.loadLastState();
            context.managedWindows.forEach((win, screenId) => {
                if (win && !win.isDestroyed()) {
                    const screenData = lastState[screenId];
                    if (screenData && screenData.url && !screenData.url.startsWith('local:')) {
                        win.loadURL(fallbackPath);
                    }
                }
            });
        };
        context.onNetworkOnline = () => {
            context.isOnline = true;
            if (context.socket && !context.socket.connected) context.socket.connect();
            context.restoreAllContent();
        };

        // START APP
        app.whenReady().then(() => {
            createTray(constants.getServerUrl(), constants.AGENT_VERSION);

            const initialConfig = loadConfig();
            if (!initialConfig.deviceId) {
                startProvisioningMode(context);
            } else {
                startNormalMode(context);
            }
        });

        // LIFECYCLE
        app.on('window-all-closed', () => {
            if (context.provisionWindow && !context.provisionWindow.isDestroyed()) {
                app.quit();
            }
        });

    } catch (error) {
        log.error('FATAL BOOTSTRAP ERROR:', error);
        showErrorWindow(error);
    }
}

function showErrorWindow(error) {
    if (!app.isReady()) {
        app.whenReady().then(() => showErrorWindow(error)).catch(() => { });
        return;
    }
    const errWin = new BrowserWindow({ width: 500, height: 400, title: "ScreensWeb Agent Update-Mode", frame: true, backgroundColor: '#1a1a1a' });
    errWin.setMenu(null);
    errWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
        <body style="background:#1a1a1a;color:#ff6600;font-family:sans-serif;padding:30px;text-align:center">
            <h2 style="margin-bottom:10px">Modo reparación</h2>
            <p style="color:#ccc;margin-bottom:20px">El agente ha encontrado un error y se está intentando corregir descargando una nueva versión.</p>
            <div style="background:#000;padding:15px;border-radius:8px;text-align:left;font-family:monospace;font-size:11px;color:#ef4444;height:120px;overflow:auto;border:1px solid #333">
                ${error.stack || error.message}
            </div>
            <p style="margin-top:20px;color:#666;font-size:12px">Buscando actualizaciones en segundo plano... No cierre esta ventana.</p>
        </body>
    `)}`);
}

// GLOBAL ERROR HANDLERS
process.on('uncaughtException', (err) => {
    log.error('[PROCESS]: Uncaught Exception', err);
});

process.on('unhandledRejection', (reason, promise) => {
    log.error('[PROCESS]: Unhandled Rejection at:', promise, 'reason:', reason);
});

bootstrap();
