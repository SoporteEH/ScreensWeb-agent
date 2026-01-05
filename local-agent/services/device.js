/**
 * Servicio de Dispositivo
 * 
 * Gestiona la identidad del dispositivo (Machine ID), el registro en el servidor
 * y comandos a nivel de sistema como el reinicio.
 */

const { machineIdSync } = require('node-machine-id');
const { exec } = require('child_process');
const { log } = require('../utils/logConfig');
const { app } = require('electron');

/**
 * Obtiene el ID único de la máquina.
 * @returns {string} ID de la máquina
 */
function getMachineId() {
    try {
        return machineIdSync();
    } catch (error) {
        log.error('[DEVICE]: Error al obtener Machine ID:', error);
        return 'unknown-device-' + Date.now();
    }
}

/**
 * Recopila información de pantallas y registra el dispositivo en el servidor via Socket.
 * @param {object} socket - Instancia de socket.io
 * @param {string} deviceId - ID del dispositivo
 * @param {Map} hardwareIdToDisplayMap - Mapa de pantallas
 */
function registerDevice(socket, deviceId, hardwareIdToDisplayMap) {
    if (!socket || !socket.connected) return;

    const screenInfo = Array.from(hardwareIdToDisplayMap.entries()).map(([hardwareId, display]) => ({
        id: hardwareId,
        size: {
            width: Math.round(display.size.width * display.scaleFactor),
            height: Math.round(display.size.height * display.scaleFactor)
        }
    }));

    log.info('[DEVICE]: Registrando dispositivo con screens:', screenInfo);
    socket.emit('registerDevice', {
        deviceId,
        screens: screenInfo,
        agentVersion: app.getVersion()
    });
}

/**
 * Ejecuta comando de reinicio según el SO.
 */
function handleRebootDevice() {
    const platform = process.platform;
    let command = '';

    if (platform === 'win32') command = 'shutdown /r /t 0';
    else if (platform === 'darwin' || platform === 'linux') command = 'sudo reboot';
    else {
        log.error(`[DEVICE]: Plataforma ${platform} no soportada para reinicio.`);
        return;
    }

    log.info(`[DEVICE]: Ejecutando comando de reinicio: ${command}`);
    exec(command, (error, stdout, stderr) => {
        if (error) log.error(`[DEVICE]: Error al reiniciar: ${error.message}`);
        if (stderr) log.error(`[DEVICE]: Stderr reinicio: ${stderr}`);
        if (stdout) log.info(`[DEVICE]: Stdout reinicio: ${stdout}`);
    });
}

module.exports = {
    getMachineId,
    registerDevice,
    handleRebootDevice
};
