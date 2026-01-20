const { machineIdSync } = require('node-machine-id');
const { exec } = require('child_process');
const { log } = require('../utils/logConfig');

/**
 * Retrieve unique hardware ID.
 * Falls back to a timestamped string if the native ID cannot be fetched.
 */
function getMachineId() {
    try {
        return machineIdSync();
    } catch (error) {
        log.error('[DEVICE]: Error Machine ID:', error);
        return 'unknown-device-' + Date.now();
    }
}

/**
 * Trigger system reboot.
 * Commands are platform-aware (Windows vs Unix).
 */
function handleRebootDevice() {
    const command = process.platform === 'win32' ? 'shutdown /r /t 0' : 'sudo reboot';
    log.info(`[DEVICE]: Reiniciando dispositivo con comando: ${command}`);

    exec(command, (err) => {
        if (err) log.error('Error durante el reinicio:', err);
    });
}

module.exports = { getMachineId, handleRebootDevice };
