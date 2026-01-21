const Store = require('electron-store');
const { log } = require('./logConfig');


const store = new Store({
    name: 'config',
    encryptionKey: 'screensweb-agent-secure-key',
    clearInvalidConfig: true
});

// Carga configuración del agente
function loadConfig() {
    try {
        return store.store;
    } catch (error) {
        log.error('[CONFIG]: Error al leer configuracion:', error);
        return {};
    }
}

// Guarda configuración
function saveConfig(config) {
    try {
        store.set(config);
    } catch (error) {
        log.error('[CONFIG]: Error al guardar configuracion:', error);
    }
}

// Elimina configuración
function deleteConfig() {
    try {
        store.clear();
        log.info('[CONFIG]: Configuracion eliminada del store.');
    } catch (error) {
        log.error('[CONFIG]: Error al limpiar configuracion:', error);
    }
}

module.exports = {
    loadConfig,
    saveConfig,
    deleteConfig,
};
