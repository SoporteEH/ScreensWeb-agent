/**
 * Provisioning Handler
 * Gestiona registro inicial del dispositivo
 */

const { BrowserWindow, app, ipcMain } = require('electron');
const path = require('path');

const { io } = require('socket.io-client');
const { log } = require('../utils/logConfig');
const { SERVER_URL } = require('../config/constants');
const { saveConfig } = require('../utils/configManager');
const { getMachineId } = require('../services/device');

// Inicia proceso de vinculación
function startProvisioningMode() {
    const deviceId = getMachineId();
    let pendingServerUrl = '';
    let socket = null;

    log.info(`[PROVISIONING]: ID de Maquina: ${deviceId}`);

    const provisionWindow = new BrowserWindow({
        width: 800,
        height: 400,
        center: true,
        icon: path.join(__dirname, '../icons/icon.ico'),
        webPreferences: {
            preload: path.join(__dirname, '../preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            spellcheck: false,
            backgroundThrottling: true,
            devTools: false
        },
        title: "Vinculación - ScreensWeb",
        backgroundColor: '#0a0a0a',
        frame: false,
        resizable: false
    });

    provisionWindow.setMenu(null);

    // Escuchar URL desde la ventana
    ipcMain.on('set-server-url', (event, url) => {
        if (socket) {
            socket.disconnect();
            socket.removeAllListeners();
        }

        pendingServerUrl = url.endsWith('/') ? url.slice(0, -1) : url;
        log.info(`[PROVISIONING]: Intentando conectar a: ${pendingServerUrl}`);

        socket = io(pendingServerUrl, {
            reconnection: true,
            reconnectionAttempts: 3,
            timeout: 10000
        });

        socket.on('connect', () => {
            log.info('[PROVISIONING]: Conexión exitosa. Registrando para vinculación...');
            socket.emit('register-for-provisioning', deviceId);
            provisionWindow.webContents.send('provision-status', {
                type: 'success',
                message: 'Conectado. Esperando vinculación desde el panel de control...'
            });
        });

        socket.on('connect_error', (error) => {
            log.error(`[PROVISIONING]: Error de conexión a ${pendingServerUrl}: ${error.message}`);
            provisionWindow.webContents.send('provision-status', {
                type: 'error',
                message: 'No se pudo conectar al servidor. Verifica la URL e intenta de nuevo.'
            });
        });

        socket.on('provision-success', async () => {
            log.info('[PROVISIONING]: Vinculación exitosa detectada. Solicitando token...');

            try {
                const response = await fetch(`${pendingServerUrl}/api/auth/agent-token`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ deviceId })
                });

                if (!response.ok) throw new Error('Error al obtener el token del servidor');

                const { token } = await response.json();

                // Guardamos todo, incluyendo la URL que funcionó
                saveConfig({
                    deviceId,
                    provisioned: true,
                    agentToken: token,
                    serverUrl: pendingServerUrl
                });

                log.info('[PROVISIONING]: Configuración guardada. Reiniciando...');

                socket.disconnect();
                app.relaunch();
                app.exit(0);
            } catch (err) {
                log.error('[PROVISIONING]: Fallo al finalizar la vinculación:', err.message);
                provisionWindow.webContents.send('provision-status', {
                    type: 'error',
                    message: `Error al finalizar: ${err.message}`
                });
            }
        });
    });

    // Manejadores básicos
    ipcMain.on('window-control', (event, action) => {
        if (!provisionWindow || provisionWindow.isDestroyed()) return;
        if (action === 'minimize') provisionWindow.minimize();
        if (action === 'close') provisionWindow.close();
    });

    provisionWindow.loadFile(path.join(__dirname, '../provision.html'));

    provisionWindow.webContents.on('did-finish-load', () => {
        provisionWindow.webContents.send('device-id', deviceId);
    });

    return provisionWindow;
}

module.exports = {
    startProvisioningMode
};
