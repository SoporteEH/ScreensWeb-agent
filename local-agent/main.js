const { app, BrowserWindow, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const { machineIdSync } = require('node-machine-id');
const { io } = require('socket.io-client');
const path = require('path');
const fs = require('fs');
const { jwtDecode } = require('jwt-decode');
const fetch = require('node-fetch');
const { exec } = require('child_process');
const log = require('electron-log');
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

// URL del servidor central se sobrescribe con la variable de entorno en producción.
const SERVER_URL = process.env.SERVER_URL || 'http://192.168.1.134:3000';
// Rutas de archivos para la configuración persistente y el estado.
const CONFIG_DIR = path.join(app.getPath('userData'), 'LuckiaScreensWeb');
const CONFIG_FILE_PATH = path.join(CONFIG_DIR, 'luckia-config.json');
const STATE_FILE_PATH = path.join(CONFIG_DIR, 'luckia-state.json');
// Endpoint para el refresco del token de agente.
const AGENT_REFRESH_URL = `${SERVER_URL}/api/auth/agent-refresh`;
const CONTENT_DIR = path.join(app.getPath('userData'), 'LuckiaScreensWeb', 'content');
const SYNC_API_URL = `${SERVER_URL}/api/users/me/local-assets`;

console.log(`[CONFIG]: Usando servidor: ${SERVER_URL}`);
console.log(`[CONFIG]: Directorio de contenido local: ${CONTENT_DIR}`)

// VARIABLES GLOBALES

let deviceId;           // ID único de la máquina.
let agentToken;         // JWT de autenticación para el agente.
let socket;             // Instancia del cliente Socket.IO.
let provisionWindow;    // Referencia a la ventana de vinculación.
let tokenRefreshInterval; // Timer para el bucle de refresco del token.
let isCheckingForUpdate = false;// Bandera cooldown de actualizacion.
let isSyncing = false; // Bandera evita sincronizaciones simultaneas.
let isOnline = false; // Bandera para indicar si la maquina esta conectada a internet.
const managedWindows = new Map(); // Mapa para gestionar las ventanas de contenido abiertas
const retryManager = new Map(); // Mapa para gestionar los reintentos

// FUNCIONES DE UTILIDAD (CONFIGURACIÓN Y AUTENTICACIÓN)

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

/**
 * Configura los listeners de electron-updater y busca actualizaciones.
 */
const checkForUpdates = () => {
    console.log('[UPDATER]: Buscando actualizaciones...');
    autoUpdater.on('update-available', () => console.log('[UPDATER]: ¡Actualizacion disponible! Empezando descarga...'));
    autoUpdater.on('update-not-available', () => console.log('[UPDATER]: Ya estas en la ultima version.'));
    autoUpdater.on('error', (err) => console.error('[UPDATER]: Error en la actualizacion:', err));
    autoUpdater.on('download-progress', (p) => console.log(`[UPDATER]: Descargando ${p.percent.toFixed(2)}%`));
    autoUpdater.on('update-downloaded', () => {
        console.log('[UPDATER]: Actualizacion descargada. Se instalara al reiniciar.');
        autoUpdater.quitAndInstall();
    });
    autoUpdater.checkForUpdates();
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
        icon: path.join(__dirname, 'build/icon.png'),
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
        console.log('[PROVISIONING]: Señal recibida. Generando token inicial...');
        try {
            const response = await fetch(`${SERVER_URL}/api/auth/agent-token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deviceId })
            });
            if (!response.ok) throw new Error('La respuesta del servidor no fue OK');
            const tokenData = await response.json();
            agentToken = tokenData.token;

            saveConfig({ deviceId, provisioned: true, agentToken });
            console.log('Configuracion guardada. Transicionando a modo normal...');

            provisionWindow.close();
            socket.disconnect();
            startNormalMode();
        } catch (e) {
            console.error('[PROVISIONING]: Error critico al obtener el token de agente:', e.message);
        }
    });
}

// MODO NORMAL (OPERACIÓN PRINCIPAL)

function startNormalMode() {
    const config = loadConfig();
    deviceId = config.deviceId;
    agentToken = config.agentToken;
    console.log(`[NORMAL]: ID de Maquina cargado: ${deviceId}`);

    startTokenRefreshLoop();
    connectToSocketServer(agentToken);

    setTimeout(restoreLastState, 2000);
    setTimeout(checkForUpdates, 15000 + Math.random() * 60000);

    screen.on('display-added', (event, newDisplay) => {
        console.log(`[DISPLAY]: Nueva pantalla detectada: ID ${newDisplay.id}`);
        if (socket?.connected) {
            // Notifica al servidor sobre la nueva configuración de pantallas.
            registerDevice(); 

            // Intenta restaurar el estado de la pantalla recién conectada desde la memoria local.
            const lastState = loadLastState();
            const stableKey = getStableScreenKey(newDisplay);
            if (lastState[stableKey]) {
                console.log(`[STATE]: Restaurando estado para la pantalla recién conectada ${newDisplay.id}...`);
                handleShowUrl({
                    action: 'show_url',
                    screenIndex: newDisplay.id,
                    url: lastState[stableKey],
                });
            }
        }
    });

    screen.on('display-removed', () => {
        console.log('[DISPLAY]: Se ha desconectado una pantalla.');
        if (socket?.connected) {
            registerDevice();
        }
    });

    screen.on('display-metrics-changed', () => {
        console.log('[DISPLAY]: Las métricas de una pantalla han cambiado (resolución, etc.).');
        if (socket?.connected) {
            registerDevice();
        }
    });
    
    // --- OPTIMIZACIÓN: GESTIÓN DE MEMORIA PERIÓDICA ---
    setInterval(() => {
        if (managedWindows.size > 0) {
            console.log('[OPTIMIZATION]: Forzando recolección de basura y limpieza de caché.');
            managedWindows.forEach(win => {
                if (win && !win.isDestroyed()) {
                    const session = win.webContents.session;
                    session.clearCache().catch(err => console.error('[OPTIMIZATION] Error al limpiar caché:', err));
                    session.clearStorageData();
                    win.webContents.collectGarbage();
                }
            });
        }
    }, 4 * 60 * 60 * 1000); // 4 horas
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
 * Recopila información sobre las pantallas conectadas y la envía al servidor.
 */
function registerDevice() {
    const displays = screen.getAllDisplays();
    const screenInfo = displays.map(d => ({
        id: d.id,
        size: { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) }
    }));
    console.log('[NORMAL]: Enviando informacion de pantallas:', screenInfo);
    socket.emit('registerDevice', { deviceId, screens: screenInfo });
}


// MANEJO DE ESTADO Y COMANDOS


/**
 * Genera una clave única y estable para una pantalla basada en su posición.
 * @param {object} display - El objeto de pantalla de Electron.
 * @returns {string} Una clave como 'x1920_y0'.
 */
function getStableScreenKey(display) {
    return `x${display.bounds.x}_y${display.bounds.y}`;
}

/**
 * Guarda la URL actual de una pantalla en el archivo de estado.
 * @param {object} display - El objeto de pantalla de Electron.
 * @param {string|null} url - La URL a guardar, o null para eliminarla.
 */
function saveCurrentState(display, url) {
    let state = {};
    try {
        if (fs.existsSync(STATE_FILE_PATH)) {
            state = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf8'));
        }
    } catch (error) {
        state = {};
    }

    const stableKey = getStableScreenKey(display);
    if (url) {
        state[stableKey] = url;
    } else {
        delete state[stableKey];
    }
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Carga de forma segura el último estado conocido desde el archivo JSON.
 * @returns {object} El objeto de estado o un objeto vacío si falla.
 */
function loadLastState() {
    try {
        if (fs.existsSync(STATE_FILE_PATH)) {
            const data = fs.readFileSync(STATE_FILE_PATH, 'utf8');
            return JSON.parse(data) || {};
        }
    } catch (error) {
        console.error('[STATE]: Error al leer el archivo de estado:', error);
    }
    return {};
}

/**
 * Restaura las URLs guardadas en las pantallas correspondientes al iniciar el agente.
 */
function restoreLastState() {
    const lastState = loadLastState();
    if (Object.keys(lastState).length === 0) return;

    console.log('[STATE]: Restaurando ultimo estado conocido:', lastState);
    const currentDisplays = screen.getAllDisplays();
    currentDisplays.forEach(display => {
        const stableKey = getStableScreenKey(display);
        if (lastState[stableKey]) {
            handleShowUrl({
                action: 'show_url',
                screenIndex: display.id,
                url: lastState[stableKey],
            });
        }
    });
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
 * Maneja el comando 'show_url'
 */
function handleShowUrl(command) {
    const { screenIndex, url, credentials } = command;

    // Cancela cualquier reintento pendiente para esta pantalla
    if (retryManager.has(screenIndex)) {
        console.log(`[RETRY]: Cancelando reintento pendiente para la pantalla ${screenIndex} debido a un nuevo comando.`);
        clearTimeout(retryManager.get(screenIndex).timerId);
        retryManager.delete(screenIndex);
    }

    // Valida que la pantalla existe
    const targetDisplay = screen.getAllDisplays().find(d => d.id === screenIndex);
    if (!targetDisplay) {
        const errorMsg = `Error: Pantalla con índice ${screenIndex} no encontrada.`;
        console.error(`[COMMAND]: ${errorMsg}`);
        sendCommandFeedback(command, 'error', errorMsg);
        return;
    }

    // GUARDA EL ESTADO DESEADO INMEDIATAMENTE
    // Si la carga posterior falla, el agente recordará esta URL para futuros reintentos.
    saveCurrentState(targetDisplay, url);

    // Comprobar conexión si la URL es web
    if (!isOnline && !url.startsWith('local:')) {
        const errorMsg = `Error: Sin conexion. No se puede cargar la URL '${url}'. Se reintentara cuando vuelva la conexion.`;
        console.error(`[RESILIENCE]: ${errorMsg}`);
        sendCommandFeedback(command, 'error', errorMsg);
        scheduleRetry(command);
        return;
    }

    // Procesar la URL final (web o local)
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

    // Intenta mostrar el contenido en la ventana
    try {
        let win = managedWindows.get(screenIndex);

        // Asegura que la ventana exista
        if (!win || win.isDestroyed()) {
            win = createContentWindow(targetDisplay, 'about:blank', command);
        }

        // Limpia listeners antiguos para evitar duplicados
        win.webContents.removeAllListeners('did-finish-load');

        // Caso especial: Auto-login para Sportradar si hay credenciales
        const shouldAutoLogin = url.startsWith('https://lcr.sportradar.com') && !!credentials;
        if (shouldAutoLogin) {
            console.log(`[AUTOLOGIN]: Detectado destino Sportradar y credenciales. Configurando auto-login...`);

            const buildAutoLoginScript = (creds) => `
                (() => {
                    try {
                        const usernameInput = document.querySelector('input[name="username"]') || document.querySelector('#username');
                        const passwordInput = document.querySelector('input[name="password"]') || document.querySelector('#password');
                        const loginButton = document.querySelector('button[type="submit"]') || document.querySelector('button[name="login"]');
                        // Nota: Los selectores anteriores son ejemplos y pueden requerir ajuste a la página real.
                        if (!usernameInput || !passwordInput || !loginButton) {
                            return { success: false, reason: 'Campos de login no encontrados. Ajusta los selectores CSS a la página real.' };
                        }
                        usernameInput.focus();
                        usernameInput.value = ${JSON.stringify(((creds && creds.username) ?? ''))};
                        usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
                        passwordInput.focus();
                        passwordInput.value = ${JSON.stringify(((creds && creds.password) ?? ''))};
                        passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
                        loginButton.click();
                        return { success: true };
                    } catch (e) {
                        return { success: false, reason: 'Excepción al ejecutar script: ' + e.message };
                    }
                })();
            `;

            const onDidFinishLoad = () => {
                try {
                    // Auto-limpieza inmediata del listener
                    win.webContents.removeListener('did-finish-load', onDidFinishLoad);
                    const currentUrl = win.webContents.getURL();
                    if (!currentUrl.startsWith('https://lcr.sportradar.com')) {
                        return;
                    }
                    const script = buildAutoLoginScript(credentials);
                    win.webContents.executeJavaScript(script)
                        .then((result) => {
                            if (result && result.success) {
                                console.log('[AUTOLOGIN]: Script inyectado correctamente. Intento de login lanzado.');
                            } else {
                                console.warn('[AUTOLOGIN]: Selectores no encontrados o script falló:', result?.reason || 'razón desconocida');
                            }
                        })
                        .catch(err => {
                            console.error('[AUTOLOGIN]: Error al ejecutar script de auto-login:', err.message);
                        });
                } catch (err) {
                    console.error('[AUTOLOGIN]: Error al preparar la inyección:', err.message);
                    win.webContents.removeListener('did-finish-load', onDidFinishLoad);
                }
            };

            // Adjunta el listener para esta navegación
            win.webContents.on('did-finish-load', onDidFinishLoad);
        }

        // Carga y enfoca: común a todas las ramas
        win.loadURL(finalUrl);
        win.focus();

        // Reporta el estado al servidor.
        if (socket && socket.connected) {
            socket.emit('reportScreenState', { deviceId, screenId: screenIndex, url });
        }

        const successMsg = `Iniciando carga de '${url}' en la pantalla.`;
        sendCommandFeedback(command, 'success', successMsg);

    } catch (error) {
        const errorMsg = `Error inesperado al ejecutar show_url: ${error.message}`;
        console.error(`[COMMAND]: ${errorMsg}`);
        sendCommandFeedback(command, 'error', errorMsg);
    }
}

/**
 * Maneja el comando 'close_screen': cierra la ventana en la pantalla especificada.
 */
function handleCloseScreen(command) {
    const { screenIndex } = command;
    const win = managedWindows.get(screenIndex);

    if (win && !win.isDestroyed()) {
        win.close();
    }

    const targetDisplay = screen.getAllDisplays().find(d => d.id === screenIndex);
    if (targetDisplay) {
        saveCurrentState(targetDisplay, null);
        socket.emit('reportScreenState', { deviceId, screenId: screenIndex, url: '' });
    }

    sendCommandFeedback(command, 'success', 'Comando de cierre ejecutado.');
}

/**
 * Maneja el comando 'identify_screen': muestra una ventana temporal para identificar la pantalla.
 */
function handleIdentifyScreen({ screenIndex, identifierText }) {
    const targetDisplay = screen.getAllDisplays().find(d => d.id === screenIndex);
    if (!targetDisplay) return;

    const identifyWin = new BrowserWindow({
        x: targetDisplay.bounds.x, y: targetDisplay.bounds.y,
        width: targetDisplay.bounds.width, height: targetDisplay.bounds.height,
        frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
        webPreferences: { preload: path.join(__dirname, 'identify-preload.js') }
    });
    identifyWin.loadFile(path.join(__dirname, 'identify.html'));
    identifyWin.webContents.on('did-finish-load', () => {
        identifyWin.webContents.send('set-identifier', identifierText);
    });

    setTimeout(() => {
        if (identifyWin && !identifyWin.isDestroyed()) identifyWin.close();
    }, 6000);
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
        // --- Obtiene lista de activos del servidor ---
        console.log('[SYNC-DEBUG]: Pidiendo lista de activos desde el servidor...');
        const response = await fetch(SYNC_API_URL, {
            headers: { 'Authorization': `Bearer ${agentToken}` }
        });
        if (!response.ok) {
            throw new Error(`Error del servidor al obtener la lista de activos: ${response.status}`);
        }
        const serverAssets = await response.json();
        console.log(`[SYNC-DEBUG]: El servidor dice que debo tener ${serverAssets.length} archivos:`, serverAssets.map(a => a.originalFilename));

        const serverAssetMap = new Map(serverAssets.map(asset => [asset.serverFilename, asset]));

        // --- Lee archivos locales existentes
        if (!fs.existsSync(CONTENT_DIR)) {
            fs.mkdirSync(CONTENT_DIR, { recursive: true });
        }
        const localFiles = fs.readdirSync(CONTENT_DIR);
        console.log(`[SYNC-DEBUG]: Encontrados ${localFiles.length} archivos locales en disco.`);

        // --- Determina que archivos eliminr
        const filesToDelete = localFiles.filter(file => !serverAssetMap.has(file));
        if (filesToDelete.length > 0) {
            console.log('[SYNC-DEBUG]: Archivos a eliminar:', filesToDelete);
            for (const fileToDelete of filesToDelete) {
                try {
                    fs.unlinkSync(path.join(CONTENT_DIR, fileToDelete));
                    console.log(`[SYNC]: Archivo obsoleto eliminado: ${fileToDelete}`);
                } catch (err) {
                    console.error(`[SYNC]: Error al eliminar el archivo ${fileToDelete}:`, err);
                }
            }
        }

        // --- Determina qué archivos descargar
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
                    console.error(`[SYNC]: Error al descargar ${assetToDownload.originalFilename}:`, err);
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


// Qué modo iniciar el agente basado en si existe una configuración.
const initialConfig = loadConfig();
if (!initialConfig.deviceId) {
    console.log('[INIT]: No se encontro configuracion. Iniciando modo vinculacion.');
    app.whenReady().then(startProvisioningMode);
} else {
    console.log('[INIT]: Configuracion encontrada. Iniciando modo normal.');
    app.whenReady().then(startNormalMode);
}

app.on('window-all-closed', () => {
    if (provisionWindow && !provisionWindow.isDestroyed()) {
        app.quit();
    } else {
        console.log('[LIFECYCLE]: Todas las ventanas de contenido cerradas, el agente sigue en ejecucion.');
    }
});