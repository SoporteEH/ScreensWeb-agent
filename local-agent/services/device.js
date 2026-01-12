/**
 * Device Service
 * Gestiona identidad del dispositivo y comandos de sistema
 */

const { machineIdSync } = require('node-machine-id');
const { exec } = require('child_process');
const { log } = require('../utils/logConfig');
const { app } = require('electron');

// Obtiene ID único de la máquina
function getMachineId() {
    try {
        return machineIdSync();
    } catch (error) {
        log.error('[DEVICE]: Error al obtener Machine ID:', error);
        return 'unknown-device-' + Date.now();
    }
}

// Registra dispositivo en el servidor
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

// Ejecuta comando de reinicio según SO
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
