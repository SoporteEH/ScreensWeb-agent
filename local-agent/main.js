/**
 * ScreensWeb Local Agent
 * Gestiona conexión WebSocket, multi-pantalla y actualizaciones automáticas
 */

const { app, BrowserWindow, screen, net } = require('electron');
const { log } = require('./utils/logConfig');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');


log.info('ScreensWeb Agent starting... (Mode: Safe-Update)');

try {
    const { configureUpdater, checkForUpdates } = require('./services/updater');
    configureUpdater();
    checkForUpdates();
} catch (updaterError) {
    log.error('Fatal: Failed to initialize auto-updater:', updaterError);
}


try {
    const {
        SERVER_URL,
        CONFIG_DIR,
        CONFIG_FILE_PATH,
        STATE_FILE_PATH,
        CONTENT_DIR,
        AGENT_REFRESH_URL,
        SYNC_API_URL,
        CONSTANTS,
        AGENT_VERSION,
    } = require('./config/constants');

    // utilidades
    const { loadConfig, saveConfig, deleteConfig } = require('./utils/configManager');

    // GPU
    const { configureGpu, configureMemory, registerGpuCrashHandlers } = require('./services/gpu');

    // Importa servicio de actualizaciones
    const { configureUpdater, checkForUpdates, handleForceUpdate } = require('./services/updater');

    // autenticación
    const { refreshAgentToken, startTokenRefreshLoop } = require('./services/auth');

    // estado y pantallas
    const {
        buildDisplayMap,
        loadLastState,
        cleanOrphanedState,
        setupAutoRefresh,
        saveCurrentState,
        restoreLastState
    } = require('./services/state');

    // activos
    const { syncLocalAssets: syncAssetsService } = require('./services/assets');

    // socket
    const { connectToSocketServer: connectSocketService, sendHeartbeat: heartbeatService } = require('./services/socket');

    // red
    const { startNetworkMonitoring: startNetworkService } = require('./services/network');

    // handlers
    const commandHandlers = require('./handlers/commands');
    const { startProvisioningMode: startProvisioningHandler } = require('./handlers/provisioning');

    // dispositivo
    const { getMachineId, registerDevice: registerDeviceService, handleRebootDevice: rebootDeviceService } = require('./services/device');
    // bandeja (Tray) y Control
    const { createTray, openControlWindow } = require('./services/tray');


    const { ipcMain } = require('electron');
    ipcMain.on('agent-action', (event, { action, data }) => {
        log.info(`[IPC]: Recibida accion: ${action}`);

        switch (action) {
            case 'restart':
            case 'restart-agent':
                log.info('[IPC]: Reiniciando agente...');
                app.relaunch();
                app.exit(0);
                break;
            case 'check-update':
                log.info('[IPC]: Forzando busqueda de actualizacion...');
                handleForceUpdate();
                break;
            case 'quit':
            case 'quit-agent':
                log.info('[IPC]: Cerrando agente...');
                app.isQuitting = true;
                app.quit();
                break;
            case 'open-control':
                openControlWindow(SERVER_URL, AGENT_VERSION);
                break;
        }
    });

    // Handler versión de la app
    const { ipcMain } = require('electron');
    ipcMain.handle('get-app-version', () => {
        return AGENT_VERSION;
    });



    log.info('App starting...');

    const gotTheLock = app.requestSingleInstanceLock();
    if (!gotTheLock) {
        app.quit();
    } else {
        app.on('second-instance', () => {
            if (provisionWindow && !provisionWindow.isDestroyed()) {
                if (provisionWindow.isMinimized()) provisionWindow.restore();
                provisionWindow.focus();
            }
        });
    }


    configureGpu();
    configureMemory();
    registerGpuCrashHandlers();




    if (app.isPackaged) {
        app.setLoginItemSettings({
            openAtLogin: true,
            path: app.getPath('exe'),
            args: ['--hidden']
        });
        log.info('[STARTUP]: Configurado inicio automático con Windows.');
    }


    log.info(`[CONFIG]: Usando servidor: ${SERVER_URL}`);
    log.info(`[CONFIG]: Directorio de contenido local: ${CONTENT_DIR}`);


    let deviceId;
    let agentToken;
    let socket;
    let provisionWindow;
    let tokenRefreshInterval;
    let isSyncing = false;
    let isOnline = false;
    let networkWasOffline = false;
    let networkCheckInterval;
    let screenChangeTimeout;
    const managedWindows = new Map();
    const identifyWindows = new Map();
    const retryManager = new Map();
    const hardwareIdToDisplayMap = new Map();
    const autoRefreshTimers = new Map();


    commandHandlers.initializeHandlers({
        get socket() { return socket; },
        get deviceId() { return deviceId; },
        get agentToken() { return agentToken; },
        managedWindows,
        identifyWindows,
        retryManager,
        hardwareIdToDisplayMap,
        autoRefreshTimers,
        isOnline: () => isOnline,
        saveCurrentState,
        handleShowUrl: (cmd, att) => handleShowUrl(cmd, att)
    });


    setInterval(() => {
        managedWindows.forEach((win, screenId) => {
            if (!win.isDestroyed() && win.webContents && win.webContents.session) {
                win.webContents.session.clearCache().catch(() => { });
            }
        });
    }, 30 * 60 * 1000);



    // Inicia modo vinculación para dispositivos sin configurar
    function startProvisioningMode() {
        provisionWindow = startProvisioningHandler({
            get socket() { return socket; }
        });
    }



    /**
     * Manejador debounced para cambios de pantalla (conexión/desconexión de monitores).
     * Espera estabilización antes de actualizar el mapa y restaurar contenido.
     * @param {string} reason - Razón del cambio: 'added', 'removed', 'metrics-changed'
     */
    function onScreenChange(reason) {
        if (screenChangeTimeout) clearTimeout(screenChangeTimeout);

        log.info(`[DISPLAY]: Detectado cambio de pantalla (${reason}). Esperando estabilización...`);

        screenChangeTimeout = setTimeout(async () => {
            log.info('[DISPLAY]: Entorno estabilizado. Actualizando mapa de pantallas.');


            const previousScreenIds = Array.from(hardwareIdToDisplayMap.keys());

            await buildDisplayMap(hardwareIdToDisplayMap);

            const currentScreenIds = Array.from(hardwareIdToDisplayMap.keys());

            if (reason === 'removed') {

                const orphanedIds = previousScreenIds.filter(id => !currentScreenIds.includes(id));
                for (const orphanedId of orphanedIds) {
                    const win = managedWindows.get(orphanedId);
                    if (win && !win.isDestroyed()) {
                        log.info(`[DISPLAY]: Cerrando ventana huerfana para pantalla ${orphanedId}`);
                        win.close();
                    }
                    managedWindows.delete(orphanedId);
                }
            }

            if (reason === 'added') {

                const newScreenIds = currentScreenIds.filter(id => !previousScreenIds.includes(id));

                if (newScreenIds.length > 0) {
                    log.info(`[DISPLAY]: Nuevas pantallas detectadas: ${newScreenIds.join(', ')}`);


                    const lastState = loadLastState();
                    for (const newId of newScreenIds) {
                        if (lastState[newId]) {
                            const screenData = lastState[newId];
                            log.info(`[DISPLAY]: Restaurando contenido en pantalla ${newId}: ${screenData.url}`);
                            setTimeout(() => {
                                handleShowUrl({
                                    action: 'show_url',
                                    screenIndex: newId,
                                    url: screenData.url,
                                    credentials: screenData.credentials || null
                                });
                            }, 500);
                        }
                    }
                }
            }

            if (socket?.connected) {
                registerDevice();
            }
        }, CONSTANTS.SCREEN_DEBOUNCE_MS);
    }

    // Inicializa modo normal del agente
    async function startNormalMode() {
        const config = loadConfig();
        deviceId = config.deviceId;
        agentToken = config.agentToken;
        log.info(`[NORMAL]: ID de Maquina cargado: ${deviceId}`);

        if (tokenRefreshInterval) clearInterval(tokenRefreshInterval);
        tokenRefreshInterval = startTokenRefreshLoop(agentToken, (newToken) => {
            agentToken = newToken;
        });


        await buildDisplayMap(hardwareIdToDisplayMap);


        restoreAllContentImmediately();


        connectToSocketServer(agentToken);


        startNetworkMonitoring();


        const updateDelay = CONSTANTS.UPDATE_CHECK_MIN_DELAY_MS + Math.random() * (CONSTANTS.UPDATE_CHECK_MAX_DELAY_MS - CONSTANTS.UPDATE_CHECK_MIN_DELAY_MS);
        setTimeout(checkForUpdates, updateDelay);

        screen.on('display-added', () => onScreenChange('added'));
        screen.on('display-removed', () => onScreenChange('removed'));
        screen.on('display-metrics-changed', () => onScreenChange('metrics-changed'));

        setInterval(sendHeartbeat, CONSTANTS.HEARTBEAT_INTERVAL_MS);

        setInterval(() => {
            if (managedWindows.size > 0) {
                log.info('[OPTIMIZATION]: Forzando limpieza de caché y storage.');
                managedWindows.forEach(win => {
                    if (win && !win.isDestroyed()) {
                        win.webContents.session.clearCache().catch(err => log.error('[OPTIMIZATION] Error al limpiar caché:', err));
                        win.webContents.session.clearStorageData().catch(err => log.error('[OPTIMIZATION] Error al limpiar storage:', err));
                    }
                });
            }
        }, CONSTANTS.GC_INTERVAL_MS);
    }

    /**
     * Restaura TODO el contenido inmediatamente sin depender del servidor.
     * Se ejecuta al inicio para garantizar que las pantallas muestren contenido
     * aunque el servidor no esté disponible.
     * - Si hay internet: carga las URLs normalmente
     * - Si NO hay internet: muestra fallback para URLs remotas, carga contenido local
     */
    function restoreAllContentImmediately() {
        const lastState = loadLastState();
        if (Object.keys(lastState).length === 0) {
            log.info('[STARTUP]: No hay estado previo para restaurar.');
            return;
        }

        const hasInternet = net.isOnline();
        log.info(`[STARTUP]: Restaurando contenido (Internet: ${hasInternet ? 'SI' : 'NO'})...`);

        const fallbackPath = `file://${path.join(__dirname, 'fallback.html')}`;
        let restoredCount = 0;

        for (const [stableId, screenData] of Object.entries(lastState)) {
            if (screenData.url && hardwareIdToDisplayMap.has(stableId)) {
                const isLocalContent = screenData.url.startsWith('local:');
                const targetDisplay = hardwareIdToDisplayMap.get(stableId);

                if (!hasInternet && !isLocalContent) {
                    // Sin internet y contenido remoto: crear ventana directamente con fallback
                    log.info(`[STARTUP]: Sin internet - creando ventana fallback en pantalla ${stableId}`);

                    setTimeout(() => {
                        // Cerrar ventana existente si hay
                        const existingWin = managedWindows.get(stableId);
                        if (existingWin && !existingWin.isDestroyed()) {
                            existingWin.close();
                        }

                        // Crear ventana directamente con el fallback (sin pasar por handleShowUrl)
                        const command = {
                            action: 'show_url',
                            screenIndex: stableId,
                            url: screenData.url,
                            credentials: screenData.credentials || null,
                            refreshInterval: screenData.refreshInterval || 0
                        };

                        const win = createContentWindow(targetDisplay, fallbackPath, command);
                        log.info(`[STARTUP]: Ventana fallback creada en pantalla ${stableId}`);
                    }, 500 * restoredCount);
                } else {

                    log.info(`[STARTUP]: Restaurando pantalla ${stableId}: ${screenData.url}${screenData.refreshInterval ? ` (auto-refresh: ${screenData.refreshInterval}min)` : ''}`);

                    setTimeout(() => {
                        handleShowUrl({
                            action: 'show_url',
                            screenIndex: stableId,
                            url: screenData.url,
                            credentials: screenData.credentials || null,
                            refreshInterval: screenData.refreshInterval || 0
                        });
                    }, 500 * restoredCount);
                }

                restoredCount++;
            }
        }

        log.info(`[STARTUP]: ${restoredCount} pantallas procesadas.`);
    }

    // Inicia monitoreo de red
    function startNetworkMonitoring() {
        if (networkCheckInterval) clearInterval(networkCheckInterval);

        networkCheckInterval = startNetworkService({
            onOffline: () => {
                isOnline = false;
                networkWasOffline = true;
                showFallbackOnRemoteWindows();
            },
            onOnline: () => {
                isOnline = true;
                networkWasOffline = false;
                if (socket && !socket.connected) {
                    log.info('[NETWORK]: Forzando reconexion del socket...');
                    socket.connect();
                }
                log.info('[NETWORK]: Restaurando contenido guardado...');
                restoreAllContentImmediately();
            },
            onCheckOnline: () => {
                if (socket && !socket.connected) {
                    log.info('[NETWORK]: Red online pero socket desconectado. Forzando reconexion...');
                    socket.connect();
                }
            }
        });
    }

    // Muestra fallback cuando se pierde internet
    function showFallbackOnRemoteWindows() {
        const fallbackPath = `file://${path.join(__dirname, 'fallback.html')}`;
        const lastState = loadLastState();

        for (const [screenId, win] of managedWindows.entries()) {
            if (win && !win.isDestroyed()) {
                const screenData = lastState[screenId];

                if (screenData && screenData.url && !screenData.url.startsWith('local:')) {
                    log.info(`[NETWORK]: Mostrando fallback en pantalla ${screenId} (sin internet)`);
                    win.loadURL(fallbackPath);
                }
            }
        }
    }

    // Conecta al servidor WebSocket
    function connectToSocketServer(token) {
        socket = connectSocketService(token, {
            onConnect: () => {
                isOnline = true;
                registerDevice();
                syncLocalAssets();
            },
            onDisconnect: (reason) => {
                isOnline = false;
            },
            onReconnect: (attemptNumber) => {
                isOnline = true;
                registerDevice();
                syncLocalAssets();
                setTimeout(() => restoreLastState(hardwareIdToDisplayMap, handleShowUrl), 1000);
            },
            onCommand: (command) => {
                log.info('[SOCKET]: Comando recibido:', command);
                if (command.action === 'show_url') handleShowUrl(command);
                if (command.action === 'close_screen') handleCloseScreen(command);
                if (command.action === 'identify_screen') handleIdentifyScreen(command);
                if (command.action === 'refresh_screen') handleRefreshScreen(command);
                if (command.action === 'reboot_device') handleRebootDevice();
                if (command.action === 'force_update') handleForceUpdate();
            },
            onAssetsUpdated: () => {
                log.info('[SYNC]: Notificacion recibida del servidor. Iniciando sincronizacion.');
                syncLocalAssets();
            },
            onForceReprovision: () => {
                log.warn('[SOCKET]: Recibido comando force-reprovision. Eliminando configuración...');
                managedWindows.forEach((win) => { if (win && !win.isDestroyed()) win.close(); });
                managedWindows.clear();
                try {
                    if (fs.existsSync(CONFIG_FILE_PATH)) fs.unlinkSync(CONFIG_FILE_PATH);
                    if (fs.existsSync(STATE_FILE_PATH)) fs.unlinkSync(STATE_FILE_PATH);
                    log.info('[SOCKET]: Configuración eliminada. Reiniciando aplicación...');
                } catch (e) {
                    log.error('[SOCKET]: Error al eliminar configuración:', e);
                }
                socket.disconnect();
                app.relaunch();
                app.quit();
            }
        });
    }

    /**
     * Ejecuta reinicio del sistema operativo host.
     */
    function handleRebootDevice() {
        rebootDeviceService();
    }


    // REGISTRO Y CONTROL DE DISPOSITIVO

    /**
     * Recopila información sobre las pantallas conectadas y la envía al servidor.
     */
    async function registerDevice() {
        registerDeviceService(socket, deviceId, hardwareIdToDisplayMap);
    }



    const {
        sendCommandFeedback,
        handleShowUrl,
        handleCloseScreen,
        handleRefreshScreen,
        handleIdentifyScreen,
        createContentWindow
    } = commandHandlers;



    // Envía heartbeat al servidor
    function sendHeartbeat() {
        heartbeatService(socket, Array.from(hardwareIdToDisplayMap.keys()));
    }

    // Sincroniza activos locales
    async function syncLocalAssets() {
        if (isSyncing) {
            log.info('[SYNC]: Sincronizacion ya en progreso. Saltando.');
            return;
        }
        isSyncing = true;
        try {
            await syncAssetsService(agentToken);
        } finally {
            isSyncing = false;
        }
    }

    // Decide modo de inicio según configuración
    const initialConfig = loadConfig();
    app.whenReady().then(() => {

        createTray(SERVER_URL, AGENT_VERSION);

        if (!initialConfig.deviceId) {
            log.info('[INIT]: No se encontro configuracion. Iniciando modo vinculacion.');
            startProvisioningMode();
        } else {
            log.info('[INIT]: Configuracion encontrada. Iniciando modo normal.');
            startNormalMode();
        }
    });

    app.on('window-all-closed', () => {
        if (provisionWindow && !provisionWindow.isDestroyed()) {
            app.quit();
        } else {
            log.info('[LIFECYCLE]: Todas las ventanas de contenido cerradas, el agente sigue en ejecucion.');
        }
    });

} catch (bootstrapError) {

    log.error('FATAL BOOTSTRAP ERROR: El agente no pudo iniciar correctamente.');
    log.error(bootstrapError);
    log.error('El agente permanecerá en espera de una auto-actualización correctiva...');

    // Intentar mostrar una ventana de error mínima si Electron está listo
    app.whenReady().then(() => {
        const { BrowserWindow } = require('electron');
        const errWin = new BrowserWindow({ width: 500, height: 400, title: "ScreensWeb Agent Update-Mode", frame: true, backgroundColor: '#1a1a1a' });
        errWin.setMenu(null);
        errWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
            <body style="background:#1a1a1a;color:#ff6600;font-family:sans-serif;padding:30px;text-align:center">
                <h2 style="margin-bottom:10px">Modo reparación</h2>
                <p style="color:#ccc;margin-bottom:20px">El agente ha encontrado un error y se está intentando corregir descargando una nueva versión.</p>
                <div style="background:#000;padding:15px;border-radius:8px;text-align:left;font-family:monospace;font-size:11px;color:#ef4444;height:120px;overflow:auto;border:1px solid #333">
                    ${bootstrapError.stack || bootstrapError.message}
                </div>
                <p style="margin-top:20px;color:#666;font-size:12px">Buscando actualizaciones en segundo plano... No cierre esta ventana.</p>
            </body>
        `)}`);
    }).catch(() => { });
}
