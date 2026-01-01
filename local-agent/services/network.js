/**
 * Servicio de Monitoreo de Red
 * 
 * Detecta cambios en la conectividad a internet y notifica al sistema.
 */

const { net } = require('electron');
const log = require('electron-log');
const { CONSTANTS } = require('../config/constants');

/**
 * Inicia el monitoreo de red.
 * @param {object} handlers - Objeto con funciones onOnline y onOffline
 * @returns {NodeJS.Timeout} ID del intervalo
 */
function startNetworkMonitoring(handlers) {
    let networkWasOffline = false;
    log.info('[NETWORK]: Iniciando monitoreo de conectividad de red.');

    const interval = setInterval(() => {
        const isOnline = net.isOnline();

        if (!isOnline && !networkWasOffline) {
            networkWasOffline = true;
            log.info('[NETWORK]: Detectada perdida de conexion a internet.');
            if (handlers.onOffline) handlers.onOffline();

        } else if (isOnline && networkWasOffline) {
            log.info('[NETWORK]: Conexion a internet restaurada!');
            networkWasOffline = false;
            if (handlers.onOnline) handlers.onOnline();

        } else if (isOnline) {
            if (handlers.onCheckOnline) handlers.onCheckOnline();
        }
    }, CONSTANTS.NETWORK_CHECK_INTERVAL_MS);

    return interval;
}

module.exports = {
    startNetworkMonitoring
};
