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
function startProvisioningMode(context) {
    const deviceId = getMachineId();
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
        title: "Vinculación de CUOTAS",
        backgroundColor: '#0a0a0a',
        frame: false,
        resizable: false
    });
    provisionWindow.setMenu(null);

    // Manejadores para controles de ventana personalizados
    ipcMain.on('window-control', (event, action) => {
        if (!provisionWindow || provisionWindow.isDestroyed()) return;

        if (action === 'minimize') {
            provisionWindow.minimize();
        } else if (action === 'close') {
            provisionWindow.close();
        }
    });

    provisionWindow.loadFile(path.join(__dirname, '../provision.html'));
    provisionWindow.webContents.on('did-finish-load', () => {
        provisionWindow.webContents.send('device-id', deviceId);
    });

    // Configurar socket con reconexión automática
    const socket = io(SERVER_URL, {
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 10000,
        randomizationFactor: 0.5,
        timeout: 10000
    });

    socket.on('connect', () => {
        log.info('[PROVISIONING]: Conectado al servidor. Esperando vinculacion...');
        socket.emit('register-for-provisioning', deviceId);
    });

    socket.on('reconnect', (attemptNumber) => {
        log.info(`[PROVISIONING]: Reconectado despues de ${attemptNumber} intentos. Re-registrando para vinculacion...`);
        socket.emit('register-for-provisioning', deviceId);
    });

    socket.on('disconnect', (reason) => {
        log.warn(`[PROVISIONING]: Desconectado del servidor. Razon: ${reason}`);
    });

    socket.on('connect_error', (error) => {
        log.error(`[PROVISIONING]: Error de conexion: ${error.message}`);
    });

    socket.on('provision-success', async () => {
        log.info('[PROVISIONING]: Pin de vinculacion del servidor recibido. Obteniendo token de agente...');

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
            const agentToken = tokenData.token;

            saveConfig({ deviceId, provisioned: true, agentToken });
            log.info('[PROVISIONING]: Configuracion guardada. Reiniciando la aplicacion en modo normal...');

            if (provisionWindow && !provisionWindow.isDestroyed()) {
                provisionWindow.close();
            }

            socket.disconnect();
            app.relaunch();
            app.quit();

        } catch (e) {
            log.error('[PROVISIONING]: Error critico durante la provision:', e.message);
            if (provisionWindow && !provisionWindow.isDestroyed()) {
                provisionWindow.webContents.send('provision-error', e.message);
            }
        }
    });

    return provisionWindow;
}

module.exports = {
    startProvisioningMode
};
