/**
 * ScreensWeb Local Agent - Main Process
 * 
 * Agente Electron para gestión remota de pantallas digitales.
 * 
 * - Conexión WebSocket resiliente con reconexión automática
 * - Gestión multi-pantalla con IDs estables por posición
 * - Restauración automática de contenido (online/offline)
 * - Auto-actualización via electron-updater
 * - Sincronización de activos locales
 * - Modo vinculación (provisioning) para nuevos dispositivos
 */

const { app, BrowserWindow, screen, net } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const { machineIdSync } = require('node-machine-id');
const { io } = require('socket.io-client');
const path = require('path');
const fs = require('fs');
const { jwtDecode } = require('jwt-decode');
const fetch = require('node-fetch');
const { exec } = require('child_process');

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

// OPTIMIZACIÓN DE RENDIMIENTO CON DETECCIÓN AUTOMÁTICA DE GPU
const GPU_CONFIG_FILE = path.join(app.getPath('userData'), 'gpu-config.json');

// Verifica si la GPU falló anteriormente
function hasGpuFailed() {
    try {
        if (fs.existsSync(GPU_CONFIG_FILE)) {
            const config = JSON.parse(fs.readFileSync(GPU_CONFIG_FILE, 'utf8'));
            return config.gpuFailed === true;
        }
    } catch (e) { /* Ignora errores de lectura */ }
    return false;
}

// Marca la GPU como fallida para futuros inicios
function markGpuAsFailed() {
    try {
        fs.writeFileSync(GPU_CONFIG_FILE, JSON.stringify({ gpuFailed: true, failedAt: new Date().toISOString() }));
        console.log('[GPU]: Marcada como fallida. Próximo inicio usará renderizado por software.');
    } catch (e) {
        console.error('[GPU]: Error guardando estado:', e);
    }
}

// Resetea el estado de GPU (para pruebas o después de actualizar drivers)
function resetGpuState() {
    try {
        if (fs.existsSync(GPU_CONFIG_FILE)) {
            fs.unlinkSync(GPU_CONFIG_FILE);
        }
    } catch (e) { /* Ignorar */ }
}

// Configurar GPU según disponibilidad
if (hasGpuFailed()) {
    console.log('[GPU]: GPU marcada como fallida anteriormente. Usando renderizado por software.');
    app.disableHardwareAcceleration();
} else {
    console.log('[GPU]: Usando aceleración de hardware (modo conservador)...');
    // Solo habilitamos opciones seguras, sin forzar GPU
    app.commandLine.appendSwitch('enable-gpu-rasterization');
}

// Optimizaciones de memoria
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512');
app.commandLine.appendSwitch('disk-cache-size', '10485760'); // 10MB
app.commandLine.appendSwitch('media-cache-size', '10485760'); // 10MB
app.commandLine.appendSwitch('disable-extensions');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('disable-translate');
app.commandLine.appendSwitch('disable-background-networking');

// Detectar crash del proceso GPU y marcar para fallback
app.on('gpu-process-crashed', (event, killed) => {
    console.error(`[GPU]: Proceso GPU crasheó (killed: ${killed}). Marcando para fallback.`);
    markGpuAsFailed();
});

// Detectar fallos en el proceso de renderizado (puede indicar problema de GPU)
app.on('render-process-gone', (event, webContents, details) => {
    if (details.reason === 'crashed' || details.reason === 'gpu-dead') {
        console.error(`[GPU]: Proceso de renderizado falló (razón: ${details.reason}). Marcando GPU como fallida.`);
        markGpuAsFailed();
    }
});

if (require('electron-squirrel-startup')) {
    app.quit();
}

// INICIO AUTOMÁTICO WINDOWS
if (app.isPackaged) {
    app.setLoginItemSettings({
        openAtLogin: true,
        path: app.getPath('exe'),
        args: ['--hidden']
    });
    log.info('[STARTUP]: Configurado inicio automático con Windows.');
}

// CONSTANTES Y CONFIGURACIÓN
// const SERVER_URL = process.env.SERVER_URL || 'http://192.168.1.137:3000';
const SERVER_URL = process.env.SERVER_URL || 'http://192.168.1.134:3000';
const CONFIG_DIR = path.join(app.getPath('userData'), 'ScreensWeb');
const CONFIG_FILE_PATH = path.join(CONFIG_DIR, 'config.json');
const STATE_FILE_PATH = path.join(CONFIG_DIR, 'state.json');
const AGENT_REFRESH_URL = `${SERVER_URL}/api/auth/agent-refresh`;
const CONTENT_DIR = path.join(app.getPath('userData'), 'ScreensWeb', 'content');
const SYNC_API_URL = `${SERVER_URL}/api/users/me/local-assets`;

console.log(`[CONFIG]: Usando servidor: ${SERVER_URL}`);
console.log(`[CONFIG]: Directorio de contenido local: ${CONTENT_DIR}`);

// CONSTANTES
const CONSTANTS = {
    HEARTBEAT_INTERVAL_MS: 30 * 1000,
    TOKEN_CHECK_INTERVAL_MS: 4 * 60 * 60 * 1000,
    UPDATE_CHECK_MIN_DELAY_MS: 15000,
    UPDATE_CHECK_MAX_DELAY_MS: 60000,
    SCREEN_DEBOUNCE_MS: 500,
    RETRY_BACKOFF_BASE_MS: 30 * 1000,
    MAX_RETRIES: 5,
    GC_INTERVAL_MS: 4 * 60 * 60 * 1000,
    NETWORK_CHECK_INTERVAL_MS: 10 * 1000, // Intervalo de monitoreo de red
    SOCKET_RECONNECT_DELAY_MAX_MS: 60 * 1000 // Máximo delay entre reconexiones
};

// VARIABLES GLOBALES
let deviceId;
let agentToken;
let socket;
let provisionWindow;
let tokenRefreshInterval;
let isCheckingForUpdate = false;
let isSyncing = false;
let isOnline = false;
let networkWasOffline = false; // Para detectar recuperación de red
let networkCheckInterval; // Intervalo de monitoreo de red
let screenChangeTimeout; // Para el debounce de pantallas
const managedWindows = new Map();
const identifyWindows = new Map(); // Ventanas de identificación por pantalla
const retryManager = new Map();
const hardwareIdToDisplayMap = new Map();
const autoRefreshTimers = new Map();

// Limpieza periódica de caché (cada 30 min)
setInterval(() => {
    managedWindows.forEach((win, screenId) => {
        if (!win.isDestroyed() && win.webContents && win.webContents.session) {
            win.webContents.session.clearCache().catch(() => { });
        }
    });
}, 30 * 60 * 1000);

// CONFIGURACIÓN Y AUTENTICACIÓN

/**
 * Carga la configuración del agente desde un archivo JSON.
 * @returns {object} El objeto de configuración o un objeto vacío si falla.
 */
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE_PATH)) {
            const data = fs.readFileSync(CONFIG_FILE_PATH, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('[CONFIG]: Error al leer/parsear el archivo de configuracion:', error);
    }
    return {};
}

/**
 * Guarda el objeto de configuración en un archivo JSON.
 * @param {object} config - El objeto de configuración a guardar.
 */
function saveConfig(config) {
    try {
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }
        fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(config, null, 2));
    } catch (error) {
        console.error('[CONFIG]: Error al guardar la configuracion:', error);
    }
}

/**
 * Llama a la API del servidor para refrescar el JWT del agente.
 * @param {string} currentAgentToken - El token actual que se va a refrescar.
 * @returns {Promise<string>} El nuevo token o el token antiguo si el refresco falla.
 */
async function refreshAgentToken(currentAgentToken) {
    console.log('[AGENT-AUTH]: Intentando refrescar el token...');
    try {
        const response = await fetch(AGENT_REFRESH_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${currentAgentToken}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ msg: 'Error de red' }));
            throw new Error(`API error: ${response.status} - ${errorData.msg}`);
        }

        const data = await response.json();
        const config = loadConfig();
        config.agentToken = data.token;
        saveConfig(config);

        console.log('[AGENT-AUTH]: Token refrescado y guardado con exito.');
        return data.token;

    } catch (error) {
        console.error('[AGENT-AUTH]: Fallo al refrescar el token:', error.message);
        return currentAgentToken; // Devuelve el token viejo si falla
    }
}

/**
 * Inicia un bucle periódico para verificar la validez del token y refrescarlo si es necesario.
 */
function startTokenRefreshLoop() {
    if (tokenRefreshInterval) {
        clearInterval(tokenRefreshInterval);
    }
    console.log('[AGENT-AUTH]: Iniciando bucle de verificacion de token (cada 4 horas).');

    tokenRefreshInterval = setInterval(async () => {
        try {
            if (!agentToken) return;

            const decoded = jwtDecode(agentToken);
            const expTimeMs = decoded.exp * 1000;
            const nowMs = Date.now();
            const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

            // Si quedan menos de 30 días para la expiración, inicia el refresco.
            if ((expTimeMs - nowMs) < THIRTY_DAYS_MS) {
                console.log('[AGENT-AUTH]: El token esta a punto de expirar, iniciando refresco...');
                agentToken = await refreshAgentToken(agentToken);
            }
        } catch (e) {
            console.error('[AGENT-AUTH]: Error en el bucle de verificacion de token:', e);
        }
    }, 4 * 60 * 60 * 1000); // 4 horas
}

// ============================================================================
// AUTO-UPDATER - Actualización automática del agente
// ============================================================================

// Configuración del autoUpdater
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';

// Configuración básica de actualización
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// - Permite downgrade para forzar actualizaciones completas
// - Desactiva actualizaciones pre-release a menos que sea necesario
autoUpdater.allowDowngrade = true;
autoUpdater.allowPrerelease = false;

// forzar descargas completas y evitar problemas de checksum
autoUpdater.forceDevUpdateConfig = true;
autoUpdater.fullChangelog = true;

/**
 * Configura los listeners de electron-updater y busca actualizaciones.
 */
const checkForUpdates = () => {
    console.log('[UPDATER]: Buscando actualizaciones...');

    // Limpiar listeners anteriores para evitar duplicados
    autoUpdater.removeAllListeners('update-available');
    autoUpdater.removeAllListeners('update-not-available');
    autoUpdater.removeAllListeners('error');
    autoUpdater.removeAllListeners('download-progress');
    autoUpdater.removeAllListeners('update-downloaded');

    autoUpdater.on('update-available', (info) => {
        console.log('[UPDATER]: ¡Actualización disponible! Version:', info.version);
        console.log('[UPDATER]: Iniciando descarga...');
    });

    autoUpdater.on('update-not-available', () => {
        console.log('[UPDATER]: Ya estás en la última versión.');
        isCheckingForUpdate = false;
    });

    autoUpdater.on('error', (err) => {
        console.error('[UPDATER]: Error en la actualizacion:', err);
        isCheckingForUpdate = false;

        // Intentar con una descarga completa después de un error
        if (err.message && err.message.includes('checksum')) {
            console.log('[UPDATER]: Error de checksum. Intentando descarga completa...');
            autoUpdater.autoDownload = true;
            autoUpdater.allowDowngrade = true;
            autoUpdater.checkForUpdates();
        }
    });

    autoUpdater.on('download-progress', (progressObj) => {
        console.log(`[UPDATER]: Descargando: ${Math.round(progressObj.percent)}%`);
    });

    autoUpdater.on('update-downloaded', (info) => {
        console.log('[UPDATER]: Actualizacion descargada. Version:', info.version);
        console.log('[UPDATER]: La actualizacion se instalará al reiniciar la aplicación.');
        // Forzar la instalación después de 5 segundos
        setTimeout(() => {
            autoUpdater.quitAndInstall(true, true);
        }, 5000);
    });

    // Forzar la descarga completa
    autoUpdater.disableWebInstaller = true;
    autoUpdater.allowDowngrade = true;

    // Iniciar la búsqueda de actualizaciones
    autoUpdater.checkForUpdates().catch(error => {
        console.error('[UPDATER]: Error al buscar actualizaciones:', error);
        isCheckingForUpdate = false;
    });
};

// ============================================================================
// MODO VINCULACIÓN (PROVISIONING) - Primera configuración del dispositivo
// ============================================================================

/**
 * Inicia el agente en modo vinculación para dispositivos sin configurar.
 * Muestra UI de vinculación y espera código PIN del administrador.
 */
function startProvisioningMode() {
    deviceId = machineIdSync();
    console.log(`[PROVISIONING]: ID de Maquina generado: ${deviceId}`);

    provisionWindow = new BrowserWindow({
        width: 800,
        height: 400,
        center: true,
        icon: path.join(__dirname, 'icons/icon.ico'),
        webPreferences: { preload: path.join(__dirname, 'preload.js') },
        title: "Asistente de Vinculacion"
    });
    provisionWindow.setMenu(null);

    provisionWindow.loadFile(path.join(__dirname, 'provision.html'));
    provisionWindow.webContents.on('did-finish-load', () => {
        provisionWindow.webContents.send('device-id', deviceId);
    });

    socket = io(SERVER_URL);
    socket.on('connect', () => {
        console.log('[PROVISIONING]: Conectado al servidor. Esperando vinculacion...');
        socket.emit('register-for-provisioning', deviceId);
    });

    socket.on('provision-success', async () => {
        console.log('[PROVISIONING]: Pin de vinculacion del servidor recibido. Obteniendo token de agente...');

        try {
            const response = await fetch(`${SERVER_URL}/api/auth/agent-token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deviceId })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(`El servidor denego la emision del token: ${response.status} - ${errorData.msg || 'Error desconocido'}`);
            }

            const tokenData = await response.json();
            agentToken = tokenData.token;

            saveConfig({ deviceId, provisioned: true, agentToken });
            console.log('[PROVISIONING]: Configuracion guardada. Reiniciando la aplicacion en modo normal...');

            if (provisionWindow && !provisionWindow.isDestroyed()) {
                provisionWindow.close();
            }

            socket.disconnect();

            app.relaunch();
            app.quit();

        } catch (e) {
            console.error('[PROVISIONING]: Error critico durante la provision:', e.message);
            if (provisionWindow && !provisionWindow.isDestroyed()) {
                provisionWindow.webContents.send('provision-error', e.message);
            }
        }
    });
}

// ============================================================================
// MODO NORMAL - Operación principal del agente
// ============================================================================

/**
 * Manejador debounced para cambios de pantalla (conexión/desconexión de monitores).
 * Espera estabilización antes de actualizar el mapa y restaurar contenido.
 * @param {string} reason - Razón del cambio: 'added', 'removed', 'metrics-changed'
 */
function onScreenChange(reason) {
    if (screenChangeTimeout) clearTimeout(screenChangeTimeout);

    console.log(`[DISPLAY]: Detectado cambio de pantalla (${reason}). Esperando estabilización...`);

    screenChangeTimeout = setTimeout(async () => {
        console.log('[DISPLAY]: Entorno estabilizado. Actualizando mapa de pantallas.');

        // Guardar IDs de pantallas antes del cambio
        const previousScreenIds = Array.from(hardwareIdToDisplayMap.keys());

        await buildDisplayMap();

        const currentScreenIds = Array.from(hardwareIdToDisplayMap.keys());

        if (reason === 'removed') {
            // Cerrar SOLO las ventanas huerfanas (pantallas que ya no existen)
            const orphanedIds = previousScreenIds.filter(id => !currentScreenIds.includes(id));
            for (const orphanedId of orphanedIds) {
                const win = managedWindows.get(orphanedId);
                if (win && !win.isDestroyed()) {
                    console.log(`[DISPLAY]: Cerrando ventana huerfana para pantalla ${orphanedId}`);
                    win.close();
                }
                managedWindows.delete(orphanedId);
            }
        }

        if (reason === 'added') {
            // Identificar SOLO las pantallas nuevas (que no existian antes)
            const newScreenIds = currentScreenIds.filter(id => !previousScreenIds.includes(id));

            if (newScreenIds.length > 0) {
                console.log(`[DISPLAY]: Nuevas pantallas detectadas: ${newScreenIds.join(', ')}`);

                // Restaurar contenido SOLO para las pantallas nuevas
                const lastState = loadLastState();
                for (const newId of newScreenIds) {
                    if (lastState[newId]) {
                        const screenData = lastState[newId];
                        console.log(`[DISPLAY]: Restaurando contenido en pantalla ${newId}: ${screenData.url}`);
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

/**
 * Inicializa el agente en modo operativo normal.
 * Carga configuración, construye mapa de pantallas, restaura contenido y conecta al servidor.
 */
async function startNormalMode() {
    const config = loadConfig();
    deviceId = config.deviceId;
    agentToken = config.agentToken;
    console.log(`[NORMAL]: ID de Maquina cargado: ${deviceId}`);

    startTokenRefreshLoop();

    // Construye el mapa de pantallas por primera vez ANTES de conectar
    await buildDisplayMap();

    // El agente funciona aunque el servidor no este disponible
    restoreAllContentImmediately();

    // Conecta al servidor (en paralelo, no bloquea la restauracion)
    connectToSocketServer(agentToken);

    // Inicia monitoreo de conectividad de red
    startNetworkMonitoring();

    // Offset aleatorio para evitar picos en el servidor
    const updateDelay = CONSTANTS.UPDATE_CHECK_MIN_DELAY_MS + Math.random() * (CONSTANTS.UPDATE_CHECK_MAX_DELAY_MS - CONSTANTS.UPDATE_CHECK_MIN_DELAY_MS);
    setTimeout(checkForUpdates, updateDelay);

    screen.on('display-added', () => onScreenChange('added'));
    screen.on('display-removed', () => onScreenChange('removed'));
    screen.on('display-metrics-changed', () => onScreenChange('metrics-changed'));

    setInterval(sendHeartbeat, CONSTANTS.HEARTBEAT_INTERVAL_MS);

    setInterval(() => {
        if (managedWindows.size > 0) {
            console.log('[OPTIMIZATION]: Forzando limpieza de caché y storage.');
            managedWindows.forEach(win => {
                if (win && !win.isDestroyed()) {
                    win.webContents.session.clearCache().catch(err => console.error('[OPTIMIZATION] Error al limpiar caché:', err));
                    win.webContents.session.clearStorageData().catch(err => console.error('[OPTIMIZATION] Error al limpiar storage:', err));
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
        console.log('[STARTUP]: No hay estado previo para restaurar.');
        return;
    }

    const hasInternet = net.isOnline();
    console.log(`[STARTUP]: Restaurando contenido (Internet: ${hasInternet ? 'SI' : 'NO'})...`);

    const fallbackPath = `file://${path.join(__dirname, 'fallback.html')}`;
    let restoredCount = 0;

    for (const [stableId, screenData] of Object.entries(lastState)) {
        if (screenData.url && hardwareIdToDisplayMap.has(stableId)) {
            const isLocalContent = screenData.url.startsWith('local:');
            const targetDisplay = hardwareIdToDisplayMap.get(stableId);

            if (!hasInternet && !isLocalContent) {
                // Sin internet y contenido remoto: crear ventana directamente con fallback
                console.log(`[STARTUP]: Sin internet - creando ventana fallback en pantalla ${stableId}`);

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
                    console.log(`[STARTUP]: Ventana fallback creada en pantalla ${stableId}`);
                }, 500 * restoredCount);
            } else {
                // Con internet o contenido local: cargar normalmente
                console.log(`[STARTUP]: Restaurando pantalla ${stableId}: ${screenData.url}${screenData.refreshInterval ? ` (auto-refresh: ${screenData.refreshInterval}min)` : ''}`);

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

    console.log(`[STARTUP]: ${restoredCount} pantallas procesadas.`);
}

/**
 * Inicia el monitoreo periódico de conectividad de red.
 * Detecta pérdida y recuperación de conexión a internet.
 * Cuando se recupera la conexión, restaura automáticamente las URLs guardadas.
 */
function startNetworkMonitoring() {
    if (networkCheckInterval) {
        clearInterval(networkCheckInterval);
    }

    console.log('[NETWORK]: Iniciando monitoreo de conectividad de red.');

    networkCheckInterval = setInterval(() => {
        const online = net.isOnline();

        if (!online && !networkWasOffline) {
            // Acabamos de perder conexión
            networkWasOffline = true;
            isOnline = false;
            console.log('[NETWORK]: Detectada perdida de conexion a internet.');

            // Mostrar fallback en todas las ventanas con contenido remoto
            showFallbackOnRemoteWindows();

        } else if (online && networkWasOffline) {
            // Acabamos de recuperar conexión
            console.log('[NETWORK]: Conexion a internet restaurada!');
            networkWasOffline = false;
            isOnline = true;

            // Forzar reconexión del socket
            if (socket && !socket.connected) {
                console.log('[NETWORK]: Forzando reconexion del socket...');
                socket.connect();
            }

            // CRITICO: Restaurar todas las URLs guardadas
            console.log('[NETWORK]: Restaurando contenido guardado...');
            restoreAllContentImmediately();

        } else if (online && socket && !socket.connected) {
            // Red online pero socket desconectado (servidor reiniciado)
            console.log('[NETWORK]: Red online pero socket desconectado. Forzando reconexion...');
            socket.connect();
        }
    }, CONSTANTS.NETWORK_CHECK_INTERVAL_MS);
}

/**
 * Muestra la página de fallback en todas las ventanas que tienen contenido remoto.
 * Se usa cuando se pierde la conexión a internet.
 */
function showFallbackOnRemoteWindows() {
    const fallbackPath = `file://${path.join(__dirname, 'fallback.html')}`;
    const lastState = loadLastState();

    for (const [screenId, win] of managedWindows.entries()) {
        if (win && !win.isDestroyed()) {
            const screenData = lastState[screenId];
            // Solo mostrar fallback si es contenido remoto (no local:)
            if (screenData && screenData.url && !screenData.url.startsWith('local:')) {
                console.log(`[NETWORK]: Mostrando fallback en pantalla ${screenId} (sin internet)`);
                win.loadURL(fallbackPath);
            }
        }
    }
}

/**
 * Establece conexión WebSocket con el servidor central.
 * Configura reconexión automática infinita y handlers para todos los eventos críticos.
 * @param {string} token - JWT del agente para autenticación
 */
function connectToSocketServer(token) {
    socket = io(SERVER_URL, {
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 3000,
        reconnectionDelayMax: CONSTANTS.SOCKET_RECONNECT_DELAY_MAX_MS,
        randomizationFactor: 0.5,
        timeout: 20000,
        auth: { token }
    });

    socket.on('connect', () => {
        isOnline = true;
        console.log('[SOCKET]: Conectado al servidor de WebSocket.');
        registerDevice();
        syncLocalAssets();
    });

    socket.on('disconnect', (reason) => {
        isOnline = false;
        console.log(`[SOCKET]: Desconectado del servidor. Razon: ${reason}`);

        // Si el servidor forzó la desconexión, reconecta manualmente
        if (reason === 'io server disconnect') {
            console.log('[SOCKET]: El servidor cerro la conexion. Reconectando manualmente...');
            socket.connect();
        }
        // Para transport close, ping timeout, etc.), socket.io reconecta automáticamente
    });

    socket.on('reconnect', (attemptNumber) => {
        console.log(`[SOCKET]:Reconectado exitosamente despues de ${attemptNumber} intentos.`);
        isOnline = true;
        registerDevice();
        syncLocalAssets();
        // Restaurar URLs remotas que pudieron fallar durante la desconexión
        setTimeout(restoreLastState, 1000);
    });

    socket.on('reconnect_attempt', (attemptNumber) => {
        console.log(`[SOCKET]:Intento de reconexion #${attemptNumber}...`);
    });

    socket.on('reconnect_error', (error) => {
        console.error(`[SOCKET]: Error en intento de reconexion: ${error.message}`);
    });

    socket.on('connect_error', (error) => {
        console.error(`[SOCKET]: Error de conexion: ${error.message}`);
        // No hacer nada especial, socket.io manejará los reintentos automáticamente
    });

    socket.on('command', (command) => {
        console.log('[SOCKET]: Comando recibido:', command);
        if (command.action === 'show_url') handleShowUrl(command);
        if (command.action === 'close_screen') handleCloseScreen(command);
        if (command.action === 'identify_screen') handleIdentifyScreen(command);
        if (command.action === 'refresh_screen') handleRefreshScreen(command);
        if (command.action === 'reboot_device') handleRebootDevice();
        if (command.action === 'force_update') handleForceUpdate();
    });

    socket.on('assets-updated', () => {
        console.log('[SYNC]: Notificacion recibida del servidor. Iniciando sincronizacion.');
        syncLocalAssets();
    });
}

/**
 * Ejecuta reinicio del sistema operativo host.
 * Soporta Windows, macOS y Linux.
 */
function handleRebootDevice() {
    let command = '';
    const platform = process.platform;

    // Determina el comando correcto basado en el sistema operativo.
    if (platform === 'win32') {
        command = 'shutdown /r /t 0';
    } else if (platform === 'darwin' || platform === 'linux') {
        command = 'shutdown -r now';
    } else {
        console.error(`[COMMAND-REBOOT]: Reboot command is not supported on platform: ${platform}`);
        return;
    }
    console.log(`[COMMAND-REBOOT]: Executing reboot command for platform '${platform}': "${command}"`);
    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.error(`[COMMAND-REBOOT]: Failed to execute reboot command. Error: ${error.message}`);
            return;
        }
        if (stderr) {
            console.error(`[COMMAND-REBOOT]: Stderr reported on reboot command: ${stderr}`);
            return;
        }
        console.log(`[COMMAND-REBOOT]: Reboot command successfully issued. Stdout: ${stdout}`);
    });
}

/**
 * Fuerza búsqueda inmediata de actualizaciones del agente.
 * Incluye cooldown de 3 minutos para evitar spam de requests.
 */
function handleForceUpdate() {
    if (isCheckingForUpdate) {
        console.log('[COMMAND-UPDATE]: Ignorando comando "force_update": ya hay una busqueda de actualizacion en curso.');
        return;
    }
    console.log('[COMMAND-UPDATE]: Received force_update command. Checking for updates now...');

    try {
        isCheckingForUpdate = true;

        autoUpdater.checkForUpdatesAndNotify();

        setTimeout(() => {
            console.log('[COMMAND-UPDATE]: Cooldown de actualizacion finalizado. Se permiten nuevas busquedas.');
            isCheckingForUpdate = false;
        }, 3 * 60 * 1000);

    } catch (error) {
        console.error('[COMMAND-UPDATE]: Failed to initiate update check.', error);
        isCheckingForUpdate = false;
    }
}

/**
 * Recopila información sobre las pantallas conectadas (usando IDs estables)
 * y la envía al servidor.
 */
async function registerDevice() {
    const screenInfo = Array.from(hardwareIdToDisplayMap.entries()).map(([hardwareId, display]) => ({
        id: hardwareId,
        size: { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) }
    }));

    console.log('[NORMAL]: Enviando informacion de pantallas con IDs de HARDWARE:', screenInfo);
    if (socket && socket.connected) {
        socket.emit('registerDevice', { deviceId, screens: screenInfo, agentVersion: app.getVersion() });
    }
}

/**
 * Construye el mapa de pantallas usando IDs simples ordenados por posición.
 * Los IDs son secuenciales: "1", "2", "3"... ordenados de izquierda a derecha.
 */
async function buildDisplayMap() {
    hardwareIdToDisplayMap.clear();
    const displays = screen.getAllDisplays();

    // Ordena pantallas por posición X (izquierda a derecha)
    displays.sort((a, b) => a.bounds.x - b.bounds.x);

    displays.forEach((display, index) => {
        const simpleId = String(index + 1);
        hardwareIdToDisplayMap.set(simpleId, display);
    });

    console.log('[DISPLAY_MAP]: Mapa de pantallas actualizado:', Array.from(hardwareIdToDisplayMap.keys()));
}


/**
 * Guarda el estado actual de una pantalla en el archivo de estado.
 * @param {string} screenIndex - El ID simple de la pantalla
 * @param {string|null} url - La URL a guardar o null para eliminar
 * @param {object|null} credentials - Credenciales para autenticación automática
 * @param {number} refreshInterval - Intervalo de auto-refresh en minutos (0 = desactivado)
 */
function saveCurrentState(screenIndex, url, credentials = null, refreshInterval = 0) {
    let state = loadLastState();

    // Limpiar timer anterior si existe
    if (autoRefreshTimers.has(screenIndex)) {
        clearInterval(autoRefreshTimers.get(screenIndex));
        autoRefreshTimers.delete(screenIndex);
        console.log(`[AUTO-REFRESH]: Timer limpiado para pantalla ${screenIndex}`);
    }

    if (url) {
        state[screenIndex] = {
            url: url,
            credentials: credentials || null,
            refreshInterval: refreshInterval || 0,
            timestamp: new Date().toISOString()
        };

        // Configurar nuevo timer de auto-refresh si está habilitado
        if (refreshInterval > 0) {
            setupAutoRefresh(screenIndex, refreshInterval);
        }
    } else {
        delete state[screenIndex];
    }

    try {
        fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2));
        console.log(`[STATE]: Estado guardado para pantalla ${screenIndex}: ${url || '(vacío)'}${refreshInterval ? ` (auto-refresh: ${refreshInterval}min)` : ''}`);
    } catch (error) {
        console.error('[STATE]: Error al guardar estado:', error);
    }
}

/**
 * Configura un timer de auto-refresh para una pantalla específica.
 * @param {string} screenIndex - ID de la pantalla
 * @param {number} intervalMinutes - Intervalo en minutos
 */
function setupAutoRefresh(screenIndex, intervalMinutes) {
    const intervalMs = intervalMinutes * 60 * 1000;

    console.log(`[AUTO-REFRESH]: Configurando auto-refresh cada ${intervalMinutes} minutos para pantalla ${screenIndex}`);

    const timerId = setInterval(() => {
        const win = managedWindows.get(screenIndex);
        if (win && !win.isDestroyed()) {
            console.log(`[AUTO-REFRESH]: Recargando pantalla ${screenIndex} (programado cada ${intervalMinutes}min)`);
            win.webContents.reload();
        } else {
            // Si la ventana ya no existe, limpiar el timer
            console.log(`[AUTO-REFRESH]: Ventana ${screenIndex} no existe, limpiando timer`);
            clearInterval(timerId);
            autoRefreshTimers.delete(screenIndex);
        }
    }, intervalMs);

    autoRefreshTimers.set(screenIndex, timerId);
}

/**
 * Carga de forma segura el último estado conocido desde el archivo JSON.
 * @returns {object} El objeto de estado o un objeto vacío si falla.
 */
function loadLastState() {
    try {
        if (fs.existsSync(STATE_FILE_PATH)) {
            const state = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf8')) || {};
            // Migrar estado antiguo al nuevo formato si es necesario
            const migratedState = {};
            for (const [key, value] of Object.entries(state)) {
                if (typeof value === 'string') {
                    // Formato antiguo (solo URL)
                    migratedState[key] = {
                        url: value,
                        credentials: null,
                        timestamp: new Date().toISOString()
                    };
                } else {
                    migratedState[key] = value;
                }
            }
            if (JSON.stringify(state) !== JSON.stringify(migratedState)) {
                fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(migratedState, null, 2));
            }
            return migratedState;
        }
    } catch (error) {
        console.error('[STATE]: Error al leer o parsear el archivo de estado:', error);
    }
    return {};
}

/**
 * Limpia el estado de pantallas que ya no existen.
 * Evita acumulación de entradas huérfanas en state.json.
 */
function cleanOrphanedState() {
    const state = loadLastState();
    const validIds = Array.from(hardwareIdToDisplayMap.keys());
    const cleanedState = {};

    for (const [id, url] of Object.entries(state)) {
        if (validIds.includes(id)) {
            cleanedState[id] = url;
        } else {
            console.log(`[STATE]: Limpiando entrada huérfana para pantalla inexistente: ${id}`);
        }
    }

    try {
        fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(cleanedState, null, 2));
    } catch (error) {
        console.error('[STATE]: Error al limpiar estado huérfano:', error);
    }

    return cleanedState;
}

/**
 * Restaura las URLs guardadas en las pantallas correspondientes al iniciar el agente.
 */
function restoreLastState() {
    console.log('[STATE]: Iniciando restauracion de estado...');
    console.log(`[STATE]: Archivo de estado: ${STATE_FILE_PATH}`);
    console.log(`[STATE]: Pantallas disponibles: ${Array.from(hardwareIdToDisplayMap.keys()).join(', ') || 'ninguna'}`);

    // Limpia entradas huérfanas antes de restaurar
    const lastState = cleanOrphanedState();

    if (Object.keys(lastState).length === 0) {
        console.log('[STATE]: No hay estado previo para restaurar (archivo vacio o no existe).');
        return;
    }

    console.log('[STATE]: Restaurando ultimo estado conocido:', JSON.stringify(lastState, null, 2));

    let restoredCount = 0;
    for (const [stableId, screenData] of Object.entries(lastState)) {
        if (hardwareIdToDisplayMap.has(stableId)) {
            console.log(`[STATE]: Restaurando pantalla ${stableId} con URL: ${screenData.url}${screenData.refreshInterval ? ` (auto-refresh: ${screenData.refreshInterval}min)` : ''}`);
            const command = {
                action: 'show_url',
                screenIndex: stableId,
                url: screenData.url,
                credentials: screenData.credentials || null,
                refreshInterval: screenData.refreshInterval || 0
            };

            // Retraso entre restauraciones para evitar sobrecarga
            setTimeout(() => {
                handleShowUrl(command);
            }, 500 * restoredCount);
            restoredCount++;
        } else {
            console.log(`[STATE]: Pantalla ${stableId} no encontrada en el mapa de displays, saltando.`);
        }
    }

    console.log(`[STATE]: Restauracion completada. ${restoredCount} pantallas restauradas.`);
}

/**
 * Maneja el comando 'show_url'.
 * Puede mostrar tanto URLs web (https://...) como activos locales (local:...).
 * Para activos locales, construye la ruta al archivo y la carga usando el protocolo 'file://'.
 */

/**
 * Envía feedback al servidor sobre el resultado de un comando.
 * @param {object} command - Comando original con commandId
 * @param {string} status - 'success' o 'error'
 * @param {string} message - Mensaje descriptivo del resultado
 */
function sendCommandFeedback(command, status, message) {
    if (!command || !command.commandId) {
        return;
    }

    // Si el comando tiene flag silent, no enviar feedback (ej: cierre masivo por desactivación)
    if (command.silent) {
        console.log(`[FEEDBACK]: Omitiendo feedback para command silencioso ${command.commandId}`);
        return;
    }

    if (socket && socket.connected) {
        const feedback = {
            deviceId,
            commandId: command.commandId,
            action: command.action,
            status,
            message,
        };
        socket.emit('command-feedback', feedback);
        console.log(`[FEEDBACK]: Enviando feedback para commandId ${command.commandId}: ${status}`);
    }
}

/**
 * Programa reintento con backoff exponencial para comandos fallidos.
 * Máximo 5 intentos: 30s, 1min, 2min, 4min, 8min.
 * @param {object} command - Comando a reintentar
 */
function scheduleRetry(command) {
    const { screenIndex } = command;

    // Obtener el intento actual o empezar desde 0
    let attempt = (retryManager.get(screenIndex)?.attempt || 0) + 1;

    // No reintentar más de 5 veces para evitar bucles infinitos
    const MAX_ATTEMPTS = 5;
    if (attempt > MAX_ATTEMPTS) {
        console.log(`[RETRY]: Se alcanzo el maximo de ${MAX_ATTEMPTS} reintentos para la pantalla ${screenIndex}. Abortando.`);
        retryManager.delete(screenIndex);
        return;
    }

    // Backoff exponencial: 30s, 1min, 2min, 4min, 8min
    const delay = Math.pow(2, attempt - 1) * 30 * 1000;

    console.log(`[RETRY]: Programando reintento #${attempt} para la pantalla ${screenIndex} en ${delay / 1000} segundos.`);

    const timerId = setTimeout(() => {
        console.log(`[RETRY]: Ejecutando reintento #${attempt} para la pantalla ${screenIndex}...`);

        retryManager.delete(screenIndex);

        handleShowUrl(command);

    }, delay);

    retryManager.set(screenIndex, { command, timerId, attempt });
}

/**
 * Crea y configura una nueva ventana de contenido, incluyendo listeners
 * para detectar fallos de carga, mostrar una página de fallback y programar reintentos.
 * @param {object} display - El objeto de pantalla de Electron donde se mostrará la ventana.
 * @param {string} urlToLoad - La URL final (ya sea file:// o https://) que se intentará cargar.
 * @param {object} command - El objeto de comando original, que contiene screenIndex, url original y commandId.
 * @returns {BrowserWindow} La instancia de la ventana creada.
 */
function createContentWindow(display, urlToLoad, command) {
    // 1. Extraemos el contentName (si existe) del comando
    const { screenIndex, url: originalUrl, contentName } = command;
    const fallbackPath = `file://${path.join(__dirname, 'fallback.html')}`;

    const win = new BrowserWindow({
        x: display.bounds.x, y: display.bounds.y,
        width: display.bounds.width, height: display.bounds.height,
        fullscreen: true,
        kiosk: true,
        frame: false,
        show: false,
        backgroundColor: '#000000',
        webPreferences: {
            partition: `persist:screen-${screenIndex}`,
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false,
            allowRunningInsecureContent: true,
            spellcheck: false,
            backgroundThrottling: false,
            devTools: !app.isPackaged,
        }
    });

    win.webContents.setZoomFactor(1);
    win.webContents.setVisualZoomLevelLimits(1, 1);

    // Mostrar cuando el contenido esté listo
    win.once('ready-to-show', () => win.show());

    // Emergencia: si ready-to-show no se dispara en 2s, forzar visualización
    setTimeout(() => {
        if (!win.isDestroyed() && !win.isVisible()) win.show();
    }, 2000);

    win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
        console.error(`[RESILIENCE]: Fallo al cargar URL '${validatedURL}'. Razón: ${errorDescription}`);

        // Ignorar errores del propio fallback
        if (validatedURL === fallbackPath) {
            console.error('[RESILIENCE]: ¡La página de fallback no se pudo cargar!');
            return;
        }

        // Si hay un commandId, enviamos feedback al servidor
        if (command.commandId) {
            const displayName = contentName ? `'${contentName}'` : `la URL '${originalUrl}'`;
            const errorMsg = `Fallo al cargar ${displayName}. Razón: ${errorDescription}`;
            sendCommandFeedback(command, 'error', errorMsg);
        }

        if (socket && socket.connected) {
            socket.emit('reportScreenState', { deviceId, screenId: screenIndex, url: '' });
        }

        // Si es error de red y no es un activo local, reintentamos
        const isNetworkError = errorCode <= -100 && errorCode >= -199;
        if (!originalUrl.startsWith('local:') && isNetworkError) {
            scheduleRetry(command);
        }

        win.loadURL(fallbackPath);
    });

    win.on('closed', () => {
        managedWindows.delete(screenIndex);
        if (retryManager.has(screenIndex)) {
            clearTimeout(retryManager.get(screenIndex).timerId);
            retryManager.delete(screenIndex);
        }
        // Limpiar caché de la sesión para liberar memoria
        if (win.webContents && win.webContents.session) {
            win.webContents.session.clearCache().catch(() => { });
            win.webContents.session.clearStorageData().catch(() => { });
        }
    });

    win.loadURL(urlToLoad);
    managedWindows.set(screenIndex, win);
    return win;
}

/**
 * Maneja el comando 'show_url', ahora usando el mapa de hardware para encontrar la pantalla.
 * @param {object} command - El objeto del comando.
 * @param {number} [currentAttempt=0] - El número de intento de reintento actual.
 */

function handleShowUrl(command, currentAttempt = 0) {
    const { screenIndex, url, credentials, contentName, refreshInterval } = command;

    if (retryManager.has(screenIndex)) {
        clearTimeout(retryManager.get(screenIndex).timerId);
        retryManager.delete(screenIndex);
    }

    const targetDisplay = hardwareIdToDisplayMap.get(screenIndex);

    if (!targetDisplay) {
        sendCommandFeedback(command, 'error', `Pantalla con ID de hardware '${screenIndex}' no encontrada.`);
        return;
    }

    saveCurrentState(screenIndex, url, credentials, refreshInterval || 0);

    if (!isOnline && !url.startsWith('local:')) {
        const errorMsg = `Error: Sin conexion. No se puede cargar la URL '${url}'. Se reintentara cuando vuelva la conexion.`;
        console.error(`[RESILIENCE]: ${errorMsg}`);
        sendCommandFeedback(command, 'error', errorMsg);
        scheduleRetry(command, currentAttempt);
        return;
    }

    let finalUrl = url;
    if (url.startsWith('local:')) {
        const filename = url.substring(6);
        const filePath = path.join(CONTENT_DIR, filename);
        if (!fs.existsSync(filePath)) {
            const errorMsg = `Error: Activo local no encontrado: ${filename}.`;
            console.error(`[COMMAND]: ${errorMsg}`);
            sendCommandFeedback(command, 'error', errorMsg);
            return;
        }
        finalUrl = `file://${filePath}`;
    }

    try {
        let win = managedWindows.get(screenIndex);
        if (!win || win.isDestroyed()) {
            win = createContentWindow(targetDisplay, 'about:blank', command);
        }

        win.webContents.removeAllListeners('did-finish-load');

        const shouldAutoLogin = url.startsWith('https://lcr.sportradar.com') && !!credentials;
        if (shouldAutoLogin) {
            console.log(`[AUTOLOGIN]: Configurando listener para Sportradar...`);
            win.webContents.on('did-finish-load', () => {
                if (!win.isDestroyed() && win.webContents.getURL().startsWith('https://lcr.sportradar.com')) {
                    console.log('[AUTOLOGIN]: Pagina de Sportradar cargada. Inyectando script mejorado...');

                    // Script actualizado con selectores de la imagen y bypass de React
                    const script = `
                        (() => {
                            return new Promise((resolve) => {
                                // Funcion auxiliar para forzar la entrada de datos en React/Frameworks
                                const setNativeValue = (element, value) => {
                                    const valueSetter = Object.getOwnPropertyDescriptor(element, 'value').set;
                                    const prototype = Object.getPrototypeOf(element);
                                    const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
                                    
                                    if (valueSetter && valueSetter !== prototypeValueSetter) {
                                        prototypeValueSetter.call(element, value);
                                    } else {
                                        valueSetter.call(element, value);
                                    }
                                    
                                    element.dispatchEvent(new Event('input', { bubbles: true }));
                                    element.dispatchEvent(new Event('change', { bubbles: true })); // Evento extra por seguridad
                                };

                                let attempts = 0;
                                const maxAttempts = 20; // 10 segundos total

                                const tryLogin = () => {
                                    try {
                                        // Selectores basados en tu imagen:
                                        const usernameInput = document.querySelector('input[name="username"]');
                                        const passwordInput = document.querySelector('input[name="password"]');
                                        const loginButton = document.querySelector('button[type="submit"]');
                                        
                                        if (usernameInput && passwordInput && loginButton) {
                                            // Usamos la funcion especial para escribir
                                            setNativeValue(usernameInput, ${JSON.stringify(credentials.username)});
                                            setNativeValue(passwordInput, ${JSON.stringify(credentials.password)});
                                            
                                            // Esperamos un instante muy breve antes de clickar (simulacion humana)
                                            setTimeout(() => {
                                                loginButton.click();
                                                resolve({ success: true, attempts });
                                            }, 200);
                                            
                                            return;
                                        }

                                        attempts++;
                                        if (attempts >= maxAttempts) {
                                            resolve({ success: false, reason: 'Timeout: Elementos (username/password/submit) no encontrados.' });
                                        } else {
                                            setTimeout(tryLogin, 500);
                                        }
                                    } catch (e) {
                                        resolve({ success: false, reason: 'Excepcion: ' + e.message });
                                    }
                                };

                                tryLogin();
                            });
                        })();
                    `;
                    win.webContents.executeJavaScript(script)
                        .then(result => {
                            if (result?.success) {
                                console.log(`[AUTOLOGIN]: Script exitoso tras ${result.attempts} intentos.`);
                            } else {
                                console.warn('[AUTOLOGIN]: Falló la inyección:', result?.reason);
                            }
                        })
                        .catch(err => console.error('[AUTOLOGIN]: Error al ejecutar script:', err));
                }
            });
        }

        win.loadURL(finalUrl);
        win.focus();

        if (socket && socket.connected) {
            socket.emit('reportScreenState', { deviceId, screenId: screenIndex, url });
        }

        const displayName = contentName || url;
        const successMsg = `Enviando '${displayName}' a la pantalla ${screenIndex}`;
        sendCommandFeedback(command, 'success', successMsg);

    } catch (error) {
        const errorMsg = `Error inesperado al ejecutar show_url: ${error.message}`;
        console.error(`[COMMAND]: ${errorMsg}`);
        sendCommandFeedback(command, 'error', errorMsg);
    }
}

/**
 * Maneja el comando 'close_screen', buscando la ventana por su ID estable.
 * @param {object} command - El objeto del comando.
 */
function handleCloseScreen(command) {
    const { screenIndex } = command;

    try {
        const win = managedWindows.get(screenIndex);

        if (win && !win.isDestroyed()) {
            win.close();
        }

        // Guardar estado vacío y reportar al servidor
        saveCurrentState(screenIndex, null);
        if (socket && socket.connected) {
            socket.emit('reportScreenState', { deviceId, screenId: screenIndex, url: '' });
        }

        sendCommandFeedback(command, 'success', `Pantalla ${screenIndex} cerrada`);
    } catch (error) {
        sendCommandFeedback(command, 'error', `Error al cerrar pantalla ${screenIndex}: ${error.message}`);
    }
}

/**
 * Recarga el contenido de una pantalla especifica
 * @param {object} command - El objeto del comando con screenIndex.
 */
function handleRefreshScreen(command) {
    const { screenIndex } = command;

    try {
        const win = managedWindows.get(screenIndex);

        if (!win || win.isDestroyed()) {
            sendCommandFeedback(command, 'error', `Pantalla ${screenIndex} no tiene contenido activo`);
            return;
        }

        console.log(`[REFRESH]: Recargando contenido en pantalla ${screenIndex}`);
        win.webContents.reload();

        sendCommandFeedback(command, 'success', `Pantalla ${screenIndex} recargada`);
    } catch (error) {
        console.error(`[REFRESH]: Error al recargar pantalla ${screenIndex}:`, error);
        sendCommandFeedback(command, 'error', `Error al recargar pantalla ${screenIndex}: ${error.message}`);
    }
}

/**
 * Muestra/oculta overlay de identificación en una pantalla específica.
 * Funciona como toggle: si ya existe, la cierra; si no, la crea.
 * Auto-cierre después de 10 segundos.
 * @param {object} command - Comando con screenIndex e identifierText
 */
function handleIdentifyScreen(command) {
    const { screenIndex, identifierText } = command;
    const targetDisplay = hardwareIdToDisplayMap.get(screenIndex);
    if (!targetDisplay) return;

    // Toggle: Si ya existe una ventana de identificación para esta pantalla, cerrarla
    const existingWin = identifyWindows.get(screenIndex);
    if (existingWin && !existingWin.isDestroyed()) {
        console.log(`[IDENTIFY]: Cerrando identificación para pantalla ${screenIndex} (clic manual)`);
        existingWin.destroy(); // destroy para limpiar proceso
        identifyWindows.delete(screenIndex);
        return;
    }

    // Crear nueva ventana de identificación
    console.log(`[IDENTIFY]: Abriendo identificación para pantalla ${screenIndex}`);
    const identifyWin = new BrowserWindow({
        x: targetDisplay.bounds.x, y: targetDisplay.bounds.y,
        width: targetDisplay.bounds.width, height: targetDisplay.bounds.height,
        frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
        webPreferences: { preload: path.join(__dirname, 'identify-preload.js') }
    });
    identifyWin.setMenu(null);
    identifyWin.loadFile(path.join(__dirname, 'identify.html'));
    identifyWin.webContents.on('did-finish-load', () => {
        identifyWin.webContents.send('set-identifier', identifierText);
    });

    identifyWindows.set(screenIndex, identifyWin);
    identifyWin.on('closed', () => {
        identifyWindows.delete(screenIndex);
    });

    // Auto-cerrar después de 10 segundos si no se cierra manualmente
    setTimeout(() => {
        if (identifyWin && !identifyWin.isDestroyed()) {
            console.log(`[IDENTIFY]: Auto-cerrando identificación para pantalla ${screenIndex} (10s timeout)`);
            identifyWin.destroy(); // destroy() en lugar de close() para limpiar proceso
        }
    }, 10000);
}

/**
 * Envía latido periódico al servidor con lista de pantallas activas.
 * Se ejecuta cada 30 segundos para mantener el estado de conexión.
 */
function sendHeartbeat() {
    if (!socket || !socket.connected) return;
    const connectedScreenIds = Array.from(hardwareIdToDisplayMap.keys());
    socket.emit('heartbeat', { screenIds: connectedScreenIds });
    console.log('[HEARTBEAT]: Enviando latido con pantallas activas:', connectedScreenIds);
}

/**
 * Sincroniza activos locales con el servidor.
 * Descarga nuevos archivos, elimina obsoletos y mantiene el directorio actualizado.
 */
async function syncLocalAssets() {
    if (isSyncing) {
        console.log('[SYNC]: Sincronizacion ya en progreso. Saltando.');
        return;
    }
    isSyncing = true;
    console.log('[SYNC]: Iniciando proceso de sincronizacion de activos locales...');

    try {
        console.log('[SYNC-DEBUG]: Pidiendo lista de activos desde el servidor...');
        const response = await fetch(SYNC_API_URL, {
            headers: { 'Authorization': `Bearer ${agentToken}` }
        });
        if (!response.ok) {
            throw new Error(`Error del servidor al obtener la lista de activos: ${response.status}`);
        }
        const serverAssets = await response.json();
        console.log(`[SYNC - DEBUG]: El servidor dice que debo tener ${serverAssets.length} archivos: `, serverAssets.map(a => a.originalFilename));

        const serverAssetMap = new Map(serverAssets.map(asset => [asset.serverFilename, asset]));

        if (!fs.existsSync(CONTENT_DIR)) {
            fs.mkdirSync(CONTENT_DIR, { recursive: true });
        }
        const localFiles = fs.readdirSync(CONTENT_DIR);
        console.log(`[SYNC - DEBUG]: Encontrados ${localFiles.length} archivos locales en disco.`);

        const filesToDelete = localFiles.filter(file => !serverAssetMap.has(file));
        if (filesToDelete.length > 0) {
            console.log('[SYNC-DEBUG]: Archivos a eliminar:', filesToDelete);
            for (const fileToDelete of filesToDelete) {
                try {
                    fs.unlinkSync(path.join(CONTENT_DIR, fileToDelete));
                    console.log(`[SYNC]: Archivo obsoleto eliminado: ${fileToDelete}`);
                } catch (err) {
                    console.error(`[SYNC]: Error al eliminar el archivo ${fileToDelete}: `, err);
                }
            }
        }

        const filesToDownload = serverAssets.filter(asset => !localFiles.includes(asset.serverFilename));
        if (filesToDownload.length > 0) {
            console.log('[SYNC-DEBUG]: Archivos a descargar:', filesToDownload.map(a => a.originalFilename));
            for (const assetToDownload of filesToDownload) {
                console.log(`[SYNC]: Descargando nuevo activo: ${assetToDownload.originalFilename}...`);
                const downloadUrl = `${SERVER_URL}/local-assets/${assetToDownload.serverFilename}`;
                const destinationPath = path.join(CONTENT_DIR, assetToDownload.serverFilename);

                try {
                    const downloadResponse = await fetch(downloadUrl);
                    if (!downloadResponse.ok) throw new Error(`Fallo la descarga: ${downloadResponse.statusText}`);

                    const fileStream = fs.createWriteStream(destinationPath);
                    await new Promise((resolve, reject) => {
                        downloadResponse.body.pipe(fileStream);
                        downloadResponse.body.on('error', reject);
                        fileStream.on('finish', resolve);
                    });
                    console.log(`[SYNC]: Descarga completa: ${assetToDownload.originalFilename}`);
                } catch (err) {
                    console.error(`[SYNC]: Error al descargar ${assetToDownload.originalFilename}: `, err);
                    if (fs.existsSync(destinationPath)) {
                        fs.unlinkSync(destinationPath);
                    }
                }
            }
        } else {
            console.log('[SYNC-DEBUG]: No hay archivos nuevos para descargar.');
        }

        console.log('[SYNC]: Proceso de sincronizacion finalizado.');

    } catch (error) {
        console.error('[SYNC]: Error critico durante la sincronizacion:', error.message);
    } finally {
        isSyncing = false;
    }
}

/**
 * Decide entre modo vinculación o modo normal según configuración existente.
 */
const initialConfig = loadConfig();
app.whenReady().then(() => {
    if (!initialConfig.deviceId) {
        console.log('[INIT]: No se encontro configuracion. Iniciando modo vinculacion.');
        startProvisioningMode();
    } else {
        console.log('[INIT]: Configuracion encontrada. Iniciando modo normal.');
        startNormalMode();
    }
});

app.on('window-all-closed', () => {
    if (provisionWindow && !provisionWindow.isDestroyed()) {
        app.quit();
    } else {
        console.log('[LIFECYCLE]: Todas las ventanas de contenido cerradas, el agente sigue en ejecucion.');
    }
});