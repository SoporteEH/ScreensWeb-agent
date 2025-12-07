const { app, BrowserWindow, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const { machineIdSync } = require('node-machine-id');
const { io } = require('socket.io-client');
const path = require('path');
const fs = require('fs');
const { jwtDecode } = require('jwt-decode');
const fetch = require('node-fetch');
const { exec } = require('child_process');

autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
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

app.disableHardwareAcceleration();

if (require('electron-squirrel-startup')) {
    app.quit();
}

// CONSTANTES Y CONFIGURACIÓN
const SERVER_URL = process.env.SERVER_URL || 'http://192.168.1.137:3000';
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
    GC_INTERVAL_MS: 4 * 60 * 60 * 1000
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
let screenChangeTimeout; // Para el debounce de pantallas
const managedWindows = new Map();
const retryManager = new Map();
const hardwareIdToDisplayMap = new Map();

// FUNCIONES CONFIGURACIÓN Y AUTENTICACIÓN

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

// LÓGICA DEL ACTUALIZADOR AUTOMÁTICO

// Configuración del autoUpdater
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.allowPrerelease = false;

// Deshabilitar actualizaciones diferenciales para evitar problemas de checksum
autoUpdater.allowDowngrade = true;
autoUpdater.allowPrerelease = false;
autoUpdater.autoDownload = true;
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
        console.log('[UPDATER]: ¡Actualización disponible! Versión:', info.version);
        console.log('[UPDATER]: Iniciando descarga...');
    });

    autoUpdater.on('update-not-available', () => {
        console.log('[UPDATER]: Ya estás en la última versión.');
        isCheckingForUpdate = false;
    });

    autoUpdater.on('error', (err) => {
        console.error('[UPDATER]: Error en la actualización:', err);
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
        console.log('[UPDATER]: Actualización descargada. Versión:', info.version);
        console.log('[UPDATER]: La actualización se instalará al reiniciar la aplicación.');
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

// MODO VINCULACIÓN (PROVISIONING)

/**
 * Inicia el agente en modo vinculación cuando no hay configuración previa.
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

// MODO NORMAL

// Manejador Debounced para cambios de pantalla
function onScreenChange(reason) {
    if (screenChangeTimeout) clearTimeout(screenChangeTimeout);

    console.log(`[DISPLAY]: Detectado cambio de pantalla (${reason}). Esperando estabilización...`);

    screenChangeTimeout = setTimeout(async () => {
        console.log('[DISPLAY]: Entorno estabilizado. Actualizando mapa de pantallas.');
        await buildDisplayMap();
        if (socket?.connected) {
            registerDevice();
            // Restaurar URLs para pantallas nuevas o reconectadas
            if (reason === 'added') {
                setTimeout(restoreLastState, 1000);
            }
        }
    }, CONSTANTS.SCREEN_DEBOUNCE_MS);
}

async function startNormalMode() {
    const config = loadConfig();
    deviceId = config.deviceId;
    agentToken = config.agentToken;
    console.log(`[NORMAL]: ID de Maquina cargado: ${deviceId}`);

    startTokenRefreshLoop();

    // Construye el mapa de pantallas por primera vez ANTES de conectar
    await buildDisplayMap();

    connectToSocketServer(agentToken);

    setTimeout(restoreLastState, 2000);
    // Offset aleatorio para evitar picos en el servidor
    const updateDelay = CONSTANTS.UPDATE_CHECK_MIN_DELAY_MS + Math.random() * (CONSTANTS.UPDATE_CHECK_MAX_DELAY_MS - CONSTANTS.UPDATE_CHECK_MIN_DELAY_MS);
    setTimeout(checkForUpdates, updateDelay);

    screen.on('display-added', () => onScreenChange('added'));
    screen.on('display-removed', () => onScreenChange('removed'));
    screen.on('display-metrics-changed', () => onScreenChange('metrics-changed'));

    setInterval(sendHeartbeat, CONSTANTS.HEARTBEAT_INTERVAL_MS);

    setInterval(() => {
        if (managedWindows.size > 0) {
            console.log('[OPTIMIZATION]: Forzando recolección de basura y limpieza de caché.');
            managedWindows.forEach(win => {
                if (win && !win.isDestroyed()) {
                    win.webContents.session.clearCache().catch(err => console.error('[OPTIMIZATION] Error al limpiar caché:', err));
                    win.webContents.session.clearStorageData();
                    win.webContents.collectGarbage();
                }
            });
        }
    }, CONSTANTS.GC_INTERVAL_MS);
}

/**
 * Establece la conexión con el servidor de WebSocket y configura los listeners de eventos.
 * @param {string} token - El JWT del agente para la autenticación.
 */
function connectToSocketServer(token) {
    socket = io(SERVER_URL, {
        reconnectionAttempts: 5,
        reconnectionDelay: 3000,
        auth: { token }
    });

    socket.on('connect', () => {
        isOnline = true;
        console.log('[NORMAL]: Conectado al servidor de WebSocket.');
        registerDevice();
        syncLocalAssets();
    });

    socket.on('disconnect', (reason) => {
        isOnline = false;
        console.log(`[NORMAL]: Desconectado del servidor: ${reason}`);
    });

    socket.on('command', (command) => {
        console.log('[NORMAL]: Comando recibido:', command);
        if (command.action === 'show_url') handleShowUrl(command);
        if (command.action === 'close_screen') handleCloseScreen(command);
        if (command.action === 'identify_screen') handleIdentifyScreen(command);
        if (command.action === 'reboot_device') handleRebootDevice();
        if (command.action === 'force_update') handleForceUpdate();
    });

    socket.on('assets-updated', () => {
        console.log('[SYNC]: Notificacion recibida del servidor. Iniciando sincronizacion.');
        syncLocalAssets();
    });
}

function handleRebootDevice() {
    let command = '';
    const platform = process.platform;

    // Determina el comando correcto basado en el sistema operativo.
    if (platform === 'win32') {
        command = 'shutdown /r /t 0';
    } else if (platform === 'darwin' || platform === 'linux') {
        command = 'shutdown -r now';
    } else {
        // Si el sistema operativo no es compatible, se registra un error y se detiene.
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

function handleForceUpdate() {
    // VERIFICA SI HAY UNA BUSQUEDA EN CURSO.
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

// NOTA: Las funciones getStableScreenId y getHardwareScreenId fueron eliminadas
// porque el sistema ahora usa IDs simples secuenciales (1, 2, 3...) ordenados por posición

/**
 * Construye el mapa de pantallas usando IDs simples ordenados por posición.
 * Los IDs son secuenciales: "1", "2", "3"... ordenados de izquierda a derecha.
 */
async function buildDisplayMap() {
    hardwareIdToDisplayMap.clear();
    const displays = screen.getAllDisplays();

    // Ordenar pantallas por posición X (izquierda a derecha)
    displays.sort((a, b) => a.bounds.x - b.bounds.x);

    displays.forEach((display, index) => {
        const simpleId = String(index + 1); // "1", "2", "3"...
        hardwareIdToDisplayMap.set(simpleId, display);
    });

    console.log('[DISPLAY_MAP]: Mapa de pantallas actualizado:', Array.from(hardwareIdToDisplayMap.keys()));
}


/**
 * Guarda la URL actual de una pantalla en el archivo de estado.
 * @param {string} screenIndex - El ID simple de la pantalla ("1", "2", etc.)
 * @param {string|null} url - La URL a guardar o null para eliminar
 */
function saveCurrentState(screenIndex, url) {
    let state = loadLastState();

    if (url) {
        state[screenIndex] = url;
    } else {
        delete state[screenIndex];
    }

    try {
        fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2));
        console.log(`[STATE]: Estado guardado para pantalla ${screenIndex}: ${url || '(vacío)'}`);
    } catch (error) {
        console.error('[STATE]: Error al guardar estado:', error);
    }
}

/**
 * Carga de forma segura el último estado conocido desde el archivo JSON.
 * @returns {object} El objeto de estado o un objeto vacío si falla.
 */
function loadLastState() {
    try {
        if (fs.existsSync(STATE_FILE_PATH)) {
            return JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf8')) || {};
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
    // Limpiar entradas huérfanas antes de restaurar
    const lastState = cleanOrphanedState();
    if (Object.keys(lastState).length === 0) return;

    console.log('[STATE]: Restaurando ultimo estado conocido:', lastState);

    for (const [stableId, url] of Object.entries(lastState)) {
        if (hardwareIdToDisplayMap.has(stableId)) {
            handleShowUrl({
                action: 'show_url',
                screenIndex: stableId,
                url: url,
            });
        }
    }
}

/**
 * Maneja el comando 'show_url'.
 * Puede mostrar tanto URLs web (https://...) como activos locales (local:...).
 * Para activos locales, construye la ruta al archivo y la carga usando el protocolo 'file://'.
 */

function sendCommandFeedback(command, status, message) {
    if (!command || !command.commandId) {
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
    const { screenIndex, url: originalUrl } = command;
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
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false,
            allowRunningInsecureContent: true,
            spellcheck: false,
            backgroundThrottling: false,
            devTools: !app.isPackaged,
        }
    });

    // Muestra la ventana solo cuando el contenido está listo para ser pintado
    win.once('ready-to-show', () => {
        win.show();
    });

    win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
        console.error(`[RESILIENCE]: Fallo al cargar URL '${validatedURL}'. Razón: ${errorDescription}`);

        if (validatedURL === fallbackPath) {
            console.error('[RESILIENCE]: ¡La página de fallback no se pudo cargar!');
            return;
        }

        if (command.commandId) {
            const errorMsg = `Fallo al cargar URL '${originalUrl}'. Razón: ${errorDescription}`;
            sendCommandFeedback(command, 'error', errorMsg);
        }

        if (socket && socket.connected) {
            socket.emit('reportScreenState', { deviceId, screenId: screenIndex, url: '' });
        }

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
    const { screenIndex, url, credentials, contentName } = command;

    if (retryManager.has(screenIndex)) {
        clearTimeout(retryManager.get(screenIndex).timerId);
        retryManager.delete(screenIndex);
    }

    const targetDisplay = hardwareIdToDisplayMap.get(screenIndex);

    if (!targetDisplay) {
        sendCommandFeedback(command, 'error', `Pantalla con ID de hardware '${screenIndex}' no encontrada.`);
        return;
    }

    saveCurrentState(screenIndex, url);

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
                    console.log('[AUTOLOGIN]: Pagina de Sportradar cargada. Inyectando script...');
                    const script = `
                        (() => {
                            return new Promise((resolve) => {
                                let attempts = 0;
                                const maxAttempts = 20; // 10 segundos total (500ms * 20)

                                const tryLogin = () => {
                                    try {
                                        const usernameInput = document.querySelector('input[name="username"]') || document.querySelector('#username');
                                        const passwordInput = document.querySelector('input[name="password"]') || document.querySelector('#password');
                                        const loginButton = document.querySelector('button[type="submit"]') || document.querySelector('button[name="login"]');
                                        
                                        if (usernameInput && passwordInput && loginButton) {
                                            usernameInput.value = ${JSON.stringify(credentials.username)};
                                            usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
                                            passwordInput.value = ${JSON.stringify(credentials.password)};
                                            passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
                                            loginButton.click();
                                            resolve({ success: true, attempts });
                                            return;
                                        }

                                        attempts++;
                                        if (attempts >= maxAttempts) {
                                            resolve({ success: false, reason: 'Timeout: Campos de login no encontrados tras 10s.' });
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

function handleIdentifyScreen(command) {
    const { screenIndex, identifierText } = command;
    const targetDisplay = hardwareIdToDisplayMap.get(screenIndex);
    if (!targetDisplay) return;

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

    setTimeout(() => {
        if (identifyWin && !identifyWin.isDestroyed()) identifyWin.close();
    }, 6000);
}

function sendHeartbeat() {
    if (!socket || !socket.connected) return;
    const connectedScreenIds = Array.from(hardwareIdToDisplayMap.keys());
    socket.emit('heartbeat', { screenIds: connectedScreenIds });
    console.log('[HEARTBEAT]: Enviando latido con pantallas activas:', connectedScreenIds);
}

/**
 * Realiza el proceso completo de sincronizacion de activos locales.
 * Obtiene la lista de activos asignados desde el servidor.
 * Compara con los archivos existentes en el directorio local.
 * Descarga los archivos faltantes.
 * Elimina los archivos locales que ya no estan asignados.
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
                const downloadUrl = `${SERVER_URL} / local - assets / ${assetToDownload.serverFilename}`;
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

// CICLO DE VIDA DE LA APP

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