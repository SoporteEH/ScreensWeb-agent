/**
 * Handler de Modo Vinculación (Provisioning)
 * 
 * Gestiona el flujo de registro inicial del dispositivo ante el servidor.
 */

const { BrowserWindow, app } = require('electron');
const path = require('path');
// Usamos el fetch nativo global de Node/Electron
const { io } = require('socket.io-client');
const { log } = require('../utils/logConfig');
const { SERVER_URL } = require('../config/constants');
const { saveConfig } = require('../utils/configManager');
const { getMachineId } = require('../services/device');

/**
 * Inicia el proceso de vinculación.
 * @param {object} context - Contexto global compartido
 */
function startProvisioningMode(context) {
    const deviceId = getMachineId();
    log.info(`[PROVISIONING]: ID de Maquina: ${deviceId}`);

    const provisionWindow = new BrowserWindow({
        width: 800,
        height: 400,
        center: true,
        icon: path.join(__dirname, '../icons/icon.ico'),
        webPreferences: { preload: path.join(__dirname, '../preload.js') },
        title: "Asistente de Vinculacion"
    });
    provisionWindow.setMenu(null);

    provisionWindow.loadFile(path.join(__dirname, '../provision.html'));
    provisionWindow.webContents.on('did-finish-load', () => {
        provisionWindow.webContents.send('device-id', deviceId);
    });

    const socket = io(SERVER_URL);
    socket.on('connect', () => {
        log.info('[PROVISIONING]: Conectado al servidor. Esperando vinculacion...');
        socket.emit('register-for-provisioning', deviceId);
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
