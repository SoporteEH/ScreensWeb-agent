/**
 * Gestión de configuración del agente con electron-store
 */
const Store = require('electron-store');
const { log } = require('./logConfig');

// Configuración de electron-store
const store = new Store({
    name: 'config',
    encryptionKey: 'screensweb-agent-secure-key',
    clearInvalidConfig: true
});

/**
 * Carga la configuración del agente.
 * @returns {object} El objeto de configuración.
 */
function loadConfig() {
    try {
        return store.store;
    } catch (error) {
        log.error('[CONFIG]: Error al leer configuración:', error);
        return {};
    }
}

/**
 * Guarda el objeto de configuración.
 * @param {object} config - El objeto a guardar.
 */
function saveConfig(config) {
    try {
        store.set(config);
    } catch (error) {
        log.error('[CONFIG]: Error al guardar configuración:', error);
    }
}

/**
 * Elimina la configuración.
 */
function deleteConfig() {
    try {
        store.clear();
        log.info('[CONFIG]: Configuración eliminada del store.');
    } catch (error) {
        log.error('[CONFIG]: Error al limpiar configuración:', error);
    }
}

module.exports = {
    loadConfig,
    saveConfig,
    deleteConfig,
};
