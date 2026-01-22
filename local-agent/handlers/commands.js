const { BrowserWindow, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { log } = require('../utils/logConfig');
const { CONTENT_DIR } = require('../config/constants');

let context = {};
// Set para evitar múltiples cargas simultáneas en la misma pantalla (Race Condition)
const loadingScreens = new Set();

/**
 * Dependency injection to keep handlers decoupled from the main process.
 */
function initializeHandlers(ctx) {
    context = ctx;
}

/**
 * Log action feedback for the local control panel.
 */
function sendCommandFeedback(command, status, message) {
    if (!command || !command.commandId) return;
    if (command.silent) return; // Silent mode for automated/restored actions
    log.info(`[COMMAND-FEEDBACK]: [ID:${command.commandId}] [Status:${status}] ${message}`);
}

/**
 * Re-attempts to load remote URLs with exponential backoff on failure.
 */
function scheduleRetry(command) {
    const { screenIndex } = command;
    // Evitar acumulaciÃ³n de retries si ya hay uno
    if (context.retryManager.has(screenIndex)) {
        clearTimeout(context.retryManager.get(screenIndex).timerId);
    }

    let attempt = (context.retryManager.get(screenIndex)?.attempt || 0) + 1;
    const MAX_ATTEMPTS = 5;

    if (attempt > MAX_ATTEMPTS) {
        log.info(`[RETRY]: Pantalla ${screenIndex} abortada tras ${MAX_ATTEMPTS} intentos.`);
        context.retryManager.delete(screenIndex);
        return;
    }

    const delayMs = Math.pow(2, attempt - 1) * 30 * 1000;
    log.info(`[RETRY]: Programando reintento #${attempt} para pantalla ${screenIndex} en ${delayMs / 1000}s`);

    const timerId = setTimeout(() => handleShowUrl(command, attempt), delayMs);
    context.retryManager.set(screenIndex, { attempt, timerId });
}

function createContentWindow(display, urlToLoad, command) {
    const { screenIndex, url: originalUrl, contentName } = command;
    const fallbackPath = `file://${path.join(__dirname, '../fallback.html')}`;

    log.info(`[WINDOW]: Creando ventana en Pantalla ${screenIndex} (${display.bounds.width}x${display.bounds.height})`);

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
            backgroundThrottling: false,
            preload: path.join(__dirname, '../content-preload.js')
        }
    });

    // Cleanup reference
    const cleanup = () => {
        if (context.retryManager.has(screenIndex)) {
            clearTimeout(context.retryManager.get(screenIndex).timerId);
            context.retryManager.delete(screenIndex);
        }
        loadingScreens.delete(screenIndex);
        context.managedWindows.delete(screenIndex);

        // Fix: Ensure window and webContents still exist before trying to remove listeners
        if (win && !win.isDestroyed()) {
            win.webContents.removeAllListeners();
        }
    };

    // Timeout de seguridad
    const loadTimeout = setTimeout(() => {
        if (!win.isDestroyed() && win.webContents.isLoading()) {
            log.warn(`[TIMEOUT]: Carga lenta en Pantalla ${screenIndex}. Forzando parada.`);
            win.webContents.stop();
        }
    }, 20000);

    win.once('ready-to-show', () => {
        if (!win.isDestroyed()) {
            win.show();
            clearTimeout(loadTimeout);
        }
    });

    win.webContents.on('did-fail-load', (e, code, desc, url) => {
        clearTimeout(loadTimeout);
        if (win.isDestroyed() || url.includes('fallback.html')) return;

        log.warn(`[FAIL-LOAD]: Pantalla ${screenIndex} (${code}: ${desc})`);

        if (!originalUrl.startsWith('local:')) {
            sendCommandFeedback(command, 'error', `Conexion perdida o lenta. Reintentando...`);
            scheduleRetry(command);
            win.loadURL(fallbackPath).catch(() => { });
        } else {
            sendCommandFeedback(command, 'error', `Error cargando archivo local: ${contentName || url}`);
        }
    });

    win.on('closed', cleanup);

    // Intentar cargar la URL inicial
    win.loadURL(urlToLoad).catch(err => {
        log.error(`[LOAD-ERR]: Error critico cargando URL inicial: ${err.message}`);
    });

    context.managedWindows.set(screenIndex, win);
    return win;
}

/**
 * MAIN ENTRY POINT: Load URL on a specific screen
 */
async function handleShowUrl(command, currentAttempt = 0) {
    const { screenIndex, url, credentials, contentName, refreshInterval } = command;

    // 1. Protección contra Race Condition (Doble Clic)
    if (loadingScreens.has(screenIndex)) {
        log.warn(`[BUSY]: Pantalla ${screenIndex} ya esta procesando una carga. Ignorando.`);
        return;
    }
    loadingScreens.add(screenIndex);

    // Liberar el flag de carga despuÃ©s de 2 segundos pase lo que pase
    setTimeout(() => loadingScreens.delete(screenIndex), 2000);

    // 2. Limpiar reintentos previos si es una nueva orden manual
    if (currentAttempt === 0 && context.retryManager.has(screenIndex)) {
        clearTimeout(context.retryManager.get(screenIndex).timerId);
        context.retryManager.delete(screenIndex);
    }

    const targetDisplay = context.hardwareIdToDisplayMap.get(screenIndex);
    if (!targetDisplay) {
        loadingScreens.delete(screenIndex);
        return sendCommandFeedback(command, 'error', 'Pantalla fisica no encontrada');
    }

    // 3. Persistencia: Guardar estado ANTES de intentar cargar (Intención vs Realidad)
    if (context.saveCurrentState) {
        await context.saveCurrentState(
            screenIndex,
            url,
            credentials,
            refreshInterval || 0,
            context.autoRefreshTimers,
            context.managedWindows,
            contentName
        );
    }

    // 4. Check rápido de Red para URLs remotas
    const { net } = require('electron');
    if (!net.isOnline() && !url.startsWith('local:')) {
        log.error('[RESILIENCE]: Sin conexion para URL remota. Activando Fallback + Retry.');
        scheduleRetry(command);

        // Cargar fallback inmediatamente si la ventana existe, si no, crearla con fallback
        let win = context.managedWindows.get(screenIndex);
        const fallbackUrl = `file://${path.join(__dirname, '../fallback.html')}`;

        if (!win || win.isDestroyed()) {
            win = createContentWindow(targetDisplay, fallbackUrl, command);
        } else {
            win.loadURL(fallbackUrl);
        }
        return;
    }

    // 5. Resolver URL Final
    let finalUrl = url.startsWith('local:')
        ? `file://${path.join(CONTENT_DIR, url.substring(6))}`
        : url;

    // 6. GestiÃ³n de Ventana
    try {
        let win = context.managedWindows.get(screenIndex);

        // Limpiar listeners antiguos de inyecciÃ³n para evitar duplicados
        if (win && !win.isDestroyed()) {
            win.webContents.removeAllListeners('did-finish-load');
        } else {
            win = createContentWindow(targetDisplay, finalUrl, command);
        }

        // 7. Lógica de Inyección de Credenciales (Auto-Login)
        if (credentials && !url.startsWith('local:')) {
            const injectCredentials = () => {
                if (!win || win.isDestroyed()) return;
                const currentUrl = win.webContents.getURL();

                const isSportradar = currentUrl.startsWith('https://lcr.sportradar.com');
                const isLuckia = currentUrl.includes('luckia.tv') || currentUrl.includes('luckia.es');

                if (!isSportradar && !isLuckia) return;

                const userVal = credentials.username || credentials.user;
                const passVal = credentials.password || credentials.pass;

                let userSelector = 'input[name="username"]';
                let passSelector = 'input[name="password"]';
                let btnSelector = 'button[type="submit"]';

                if (isLuckia) {
                    userSelector = 'input[name="username"], input[name="user"], input[id*="user"], input[type="text"][placeholder*="Usuario"]';
                    passSelector = 'input[name="password"], input[name="pass"], input[id*="pass"], input[type="password"]';
                    btnSelector = 'button[type="submit"], .btn-login, #login-btn, #btnLogin, .luckia-login-btn';
                }

                const script = `
                    (() => {
                        return new Promise((resolve) => {
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
                            };

                            let attempts = 0;
                            const tryLogin = () => {
                                const u = document.querySelector(${JSON.stringify(userSelector)});
                                const p = document.querySelector(${JSON.stringify(passSelector)});
                                const b = document.querySelector(${JSON.stringify(btnSelector)});

                                if (u && p && b) {
                                    setNativeValue(u, ${JSON.stringify(userVal)});
                                    setNativeValue(p, ${JSON.stringify(passVal)});
                                    setTimeout(() => { b.click(); resolve(true); }, 300);
                                    return;
                                }

                                if (attempts++ < 30) { 
                                    setTimeout(tryLogin, 500);
                                } else {
                                    resolve(false);
                                }
                            };
                            tryLogin();
                        });
                    })();
                `;
                win.webContents.executeJavaScript(script).catch(err => log.error('[AUTOLOGIN] Error:', err));
            };

            win.webContents.once('did-finish-load', injectCredentials);

            // Explicit cleanup listener
            win.once('closed', () => {
                if (win && !win.isDestroyed() && win.webContents) {
                    win.webContents.removeListener('did-finish-load', injectCredentials);
                }
            });
        }

        // Cargar URL si la ventana ya existÃ­a (si es nueva, createContentWindow ya la carga)
        if (win.webContents.getURL() !== finalUrl) {
            win.loadURL(finalUrl).catch(e => log.warn(`[LOAD] Retry load: ${e.message}`));
        }

        // Traer al frente
        win.show();

        sendCommandFeedback(command, 'success', `Cargando: ${contentName || url}`);

    } catch (e) {
        log.error(`[CMD-ERROR]: ${e.message}`);
        loadingScreens.delete(screenIndex);
    }
}

/**
 * Close content on a screen and clear state.
 */
async function handleCloseScreen(command) {
    const { screenIndex } = command;
    try {
        const win = context.managedWindows.get(screenIndex);
        if (win && !win.isDestroyed()) win.close();

        // Eliminar reintentos pendientes si cerramos manualmente
        if (context.retryManager.has(screenIndex)) {
            clearTimeout(context.retryManager.get(screenIndex).timerId);
            context.retryManager.delete(screenIndex);
        }

        if (context.saveCurrentState) {
            await context.saveCurrentState(screenIndex, null, null, 0, context.autoRefreshTimers, context.managedWindows);
        }
        sendCommandFeedback(command, 'success', `Pantalla ${screenIndex} cerrada`);
    } catch (error) {
        sendCommandFeedback(command, 'error', `Error cerrando pantalla: ${error.message}`);
    }
}

/**
 * Identification Overlay - Fully implemented
 */
function handleIdentifyScreen(command) {
    const { screenIndex, identifierText } = command;
    const targetDisplay = context.hardwareIdToDisplayMap.get(screenIndex);

    if (!targetDisplay) return;

    log.info(`[IDENTIFY]: Identificando Pantalla ${screenIndex}`);

    // Limpiar identificaciÃ³n previa si existe
    const existingWin = context.identifyWindows.get(screenIndex);
    if (existingWin && !existingWin.isDestroyed()) {
        existingWin.close();
        context.identifyWindows.delete(screenIndex);
        return; // Toggle behavior (si ya estÃ¡, la cierra)
    }

    const identifyWin = new BrowserWindow({
        x: targetDisplay.bounds.x, y: targetDisplay.bounds.y,
        width: targetDisplay.bounds.width, height: targetDisplay.bounds.height,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        webPreferences: {
            preload: path.join(__dirname, '../identify-preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    identifyWin.setMenu(null);
    identifyWin.setIgnoreMouseEvents(true); // Click-through
    identifyWin.loadFile(path.join(__dirname, '../identify.html'));

    identifyWin.webContents.on('did-finish-load', () => {
        identifyWin.webContents.send('set-identifier', identifierText);
    });

    context.identifyWindows.set(screenIndex, identifyWin);

    identifyWin.on('closed', () => context.identifyWindows.delete(screenIndex));

    // Auto-cierre a los 10 segundos
    setTimeout(() => {
        if (!identifyWin.isDestroyed()) identifyWin.close();
    }, 10000);
}

/**
 * Force a reload of a screen's content based on its last state.
 * Used for network recovery.
 */
async function handleRecoverScreen(screenId) {
    const { loadLastState } = require('../services/state');
    const lastState = await loadLastState();
    const stateData = lastState[String(screenId)];

    if (stateData && stateData.url) {
        log.info(`[RESILIENCE]: Recuperando Pantalla ${screenId} (${stateData.contentName || stateData.url})`);

        handleShowUrl({
            action: 'show_url',
            screenIndex: String(screenId),
            url: stateData.url,
            credentials: stateData.credentials || null,
            refreshInterval: stateData.refreshInterval || 0,
            contentName: stateData.contentName || null,
            silent: true
        });
    }
}

module.exports = {
    initializeHandlers,
    handleShowUrl,
    handleCloseScreen,
    handleIdentifyScreen,
    handleRecoverScreen,
    sendCommandFeedback,
    createContentWindow
}