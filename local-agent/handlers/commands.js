/**
 * Command Handlers
 * Gestiona ejecución de comandos remotos
 */

const { BrowserWindow, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { log } = require('../utils/logConfig');
const { CONTENT_DIR } = require('../config/constants');

let context = {};

// Inicializa handlers con contexto global
function initializeHandlers(ctx) {
    context = ctx;
}

// Envía feedback del comando al servidor
function sendCommandFeedback(command, status, message) {
    if (!command || !command.commandId) return;
    if (command.silent) return;

    if (context.socket && context.socket.connected) {
        context.socket.emit('command-feedback', {
            deviceId: context.deviceId,
            commandId: command.commandId,
            action: command.action,
            status,
            message,
        });
        log.info(`[FEEDBACK]: Enviando feedback para commandId ${command.commandId}: ${status}`);
    }
}

// Programa reintento con backoff exponencial
function scheduleRetry(command) {
    const { screenIndex } = command;
    let attempt = (context.retryManager.get(screenIndex)?.attempt || 0) + 1;
    const MAX_ATTEMPTS = 5;

    if (attempt > MAX_ATTEMPTS) {
        log.info(`[RETRY]: Se alcanzo el maximo de ${MAX_ATTEMPTS} reintentos para la pantalla ${screenIndex}. Abortando.`);
        context.retryManager.delete(screenIndex);
        return;
    }

    const delayMs = Math.pow(2, attempt - 1) * 30 * 1000;
    log.info(`[RETRY]: Programando reintento #${attempt} para la pantalla ${screenIndex} en ${delayMs / 1000} segundos.`);

    const timerId = setTimeout(() => {
        log.info(`[RETRY]: Ejecutando reintento #${attempt} para la pantalla ${screenIndex}...`);
        handleShowUrl(command, attempt);
    }, delayMs);

    context.retryManager.set(screenIndex, { attempt, timerId });
}

/**
 * Crea una ventana de contenido perfectamente configurada para señalización.
 */
function createContentWindow(display, urlToLoad, command) {
    const { screenIndex, url: originalUrl, contentName } = command;
    const fallbackPath = `file://${path.join(__dirname, '../fallback.html')}`;

    log.info(`[COMMAND]: Creando ventana en pantalla ${screenIndex} (${display.bounds.width}x${display.bounds.height})`);

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
            // WARNING: Desactivado para permitir iframes y contenido mixto en señalización.
            // Solo URLs seguras deberian llegar aquí (validadas en backend).
            webSecurity: false,
            allowRunningInsecureContent: true,
            backgroundThrottling: true,
            devTools: false,
            spellcheck: false,
            enableWebSQL: false,
            navigateOnDragDrop: false,
        }
    });

    win.webContents.setZoomFactor(1);
    win.webContents.setVisualZoomLevelLimits(1, 1);

    win.once('ready-to-show', () => win.show());

    // Fallback timer para mostrar ventana
    setTimeout(() => {
        if (!win.isDestroyed() && !win.isVisible()) win.show();
    }, 2000);

    win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
        log.error(`[RESILIENCE]: Fallo al cargar URL '${validatedURL}'. Razón: ${errorDescription}`);

        if (validatedURL === fallbackPath) return;

        if (command.commandId) {
            const displayName = contentName ? `'${contentName}'` : `la URL '${originalUrl}'`;
            sendCommandFeedback(command, 'error', `Fallo al cargar ${displayName}. Razón: ${errorDescription}`);
        }

        const isNetworkError = errorCode <= -100 && errorCode >= -199;
        if (!originalUrl.startsWith('local:') && isNetworkError) {
            scheduleRetry(command);
        }
        win.loadURL(fallbackPath);
    });

    const windowSession = win.webContents.session;
    win.on('closed', () => {
        context.managedWindows.delete(screenIndex);
        if (context.retryManager.has(screenIndex)) {
            clearTimeout(context.retryManager.get(screenIndex).timerId);
            context.retryManager.delete(screenIndex);
        }
        if (windowSession) {
            windowSession.clearCache().catch(() => { });
            windowSession.clearStorageData().catch(() => { });
        }
    });

    win.loadURL(urlToLoad);
    context.managedWindows.set(screenIndex, win);
    return win;
}

/**
 * Maneja el comando 'show_url'.
 */
function handleShowUrl(command, currentAttempt = 0) {
    const { screenIndex, url, credentials, contentName, refreshInterval } = command;

    if (context.retryManager.has(screenIndex)) {
        clearTimeout(context.retryManager.get(screenIndex).timerId);
        context.retryManager.delete(screenIndex);
    }

    const targetDisplay = context.hardwareIdToDisplayMap.get(screenIndex);
    if (!targetDisplay) {
        sendCommandFeedback(command, 'error', `Pantalla con ID de hardware '${screenIndex}' no encontrada.`);
        return;
    }

    if (context.saveCurrentState) {
        context.saveCurrentState(screenIndex, url, credentials, refreshInterval || 0, context.autoRefreshTimers, context.managedWindows);
    }

    const { net } = require('electron');
    const hasInternet = net.isOnline();

    if (!hasInternet && !url.startsWith('local:')) {
        const errorMsg = `Error: Sin conexion. No se puede cargar la URL '${url}'. Se reintentara cuando vuelva la conexion.`;
        log.error(`[RESILIENCE]: ${errorMsg}`);
        sendCommandFeedback(command, 'error', errorMsg);
        scheduleRetry(command);
        return;
    }

    let finalUrl = url;
    if (url.startsWith('local:')) {
        const filename = url.substring(6);
        const filePath = path.join(CONTENT_DIR, filename);
        if (!fs.existsSync(filePath)) {
            const errorMsg = `Error: Activo local no encontrado: ${filename}.`;
            log.error(`[COMMAND]: ${errorMsg}`);
            sendCommandFeedback(command, 'error', errorMsg);
            return;
        }
        finalUrl = `file://${filePath}`;
    }

    try {
        let win = context.managedWindows.get(screenIndex);
        if (!win || win.isDestroyed()) {
            win = createContentWindow(targetDisplay, 'about:blank', command);
        }

        win.webContents.removeAllListeners('did-finish-load');

        // Logic for Sportradar
        if (url.startsWith('https://lcr.sportradar.com') && !!credentials) {
            win.webContents.on('did-finish-load', () => {
                if (!win.isDestroyed() && win.webContents.getURL().startsWith('https://lcr.sportradar.com')) {
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
                                    const usernameInput = document.querySelector('input[name="username"]');
                                    const passwordInput = document.querySelector('input[name="password"]');
                                    const loginButton = document.querySelector('button[type="submit"]');
                                    if (usernameInput && passwordInput && loginButton) {
                                        setNativeValue(usernameInput, ${JSON.stringify(credentials.username)});
                                        setNativeValue(passwordInput, ${JSON.stringify(credentials.password)});
                                        setTimeout(() => { loginButton.click(); resolve({ success: true, attempts }); }, 200);
                                        return;
                                    }
                                    if (attempts++ < 20) setTimeout(tryLogin, 500);
                                    else resolve({ success: false, reason: 'Timeout' });
                                };
                                tryLogin();
                            });
                        })();
                    `;
                    win.webContents.executeJavaScript(script).catch(err => log.error('[AUTOLOGIN] Error:', err));
                }
            });
        }

        win.loadURL(finalUrl);
        win.focus();

        if (context.socket && context.socket.connected) {
            context.socket.emit('reportScreenState', { deviceId: context.deviceId, screenId: screenIndex, url });
        }

        const displayName = contentName || url;
        sendCommandFeedback(command, 'success', `Enviando '${displayName}' a la pantalla ${screenIndex}`);

    } catch (error) {
        const errorMsg = `Error inesperado al ejecutar show_url: ${error.message}`;
        log.error(`[COMMAND]: ${errorMsg}`);
        sendCommandFeedback(command, 'error', errorMsg);
    }
}

/**
 * Maneja el comando 'close_screen'.
 */
function handleCloseScreen(command) {
    const { screenIndex } = command;
    try {
        const win = context.managedWindows.get(screenIndex);
        if (win && !win.isDestroyed()) win.close();

        if (context.saveCurrentState) {
            context.saveCurrentState(screenIndex, null, null, 0, context.autoRefreshTimers, context.managedWindows);
        }
        if (context.socket && context.socket.connected) {
            context.socket.emit('reportScreenState', { deviceId: context.deviceId, screenId: screenIndex, url: '' });
        }
        sendCommandFeedback(command, 'success', `Pantalla ${screenIndex} cerrada`);
    } catch (error) {
        sendCommandFeedback(command, 'error', `Error al cerrar pantalla ${screenIndex}: ${error.message}`);
    }
}

/**
 * Maneja el comando 'refresh_screen'.
 */
function handleRefreshScreen(command) {
    const { screenIndex } = command;
    try {
        const win = context.managedWindows.get(screenIndex);
        if (!win || win.isDestroyed()) {
            sendCommandFeedback(command, 'error', `Pantalla ${screenIndex} no tiene contenido activo`);
            return;
        }
        win.webContents.reload();
        sendCommandFeedback(command, 'success', `Pantalla ${screenIndex} recargada`);
    } catch (error) {
        sendCommandFeedback(command, 'error', `Error al recargar pantalla ${screenIndex}: ${error.message}`);
    }
}

/**
 * Maneja el comando 'identify_screen'.
 */
function handleIdentifyScreen(command) {
    const { screenIndex, identifierText } = command;
    const targetDisplay = context.hardwareIdToDisplayMap.get(screenIndex);
    if (!targetDisplay) return;

    const existingWin = context.identifyWindows.get(screenIndex);
    if (existingWin && !existingWin.isDestroyed()) {
        existingWin.destroy();
        context.identifyWindows.delete(screenIndex);
        return;
    }

    const identifyWin = new BrowserWindow({
        x: targetDisplay.bounds.x, y: targetDisplay.bounds.y,
        width: targetDisplay.bounds.width, height: targetDisplay.bounds.height,
        frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
        webPreferences: { preload: path.join(__dirname, '../identify-preload.js') }
    });
    identifyWin.setMenu(null);
    identifyWin.loadFile(path.join(__dirname, '../identify.html'));
    identifyWin.webContents.on('did-finish-load', () => {
        identifyWin.webContents.send('set-identifier', identifierText);
    });

    context.identifyWindows.set(screenIndex, identifyWin);
    identifyWin.on('closed', () => context.identifyWindows.delete(screenIndex));

    setTimeout(() => {
        if (identifyWin && !identifyWin.isDestroyed()) identifyWin.destroy();
    }, 10000);
}

module.exports = {
    initializeHandlers,
    handleShowUrl,
    handleCloseScreen,
    handleIdentifyScreen,
    handleRefreshScreen,
    sendCommandFeedback,
    createContentWindow
};
