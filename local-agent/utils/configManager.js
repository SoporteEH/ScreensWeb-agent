/**
 * Gestión de configuración del agente
 * 
 * Maneja la carga y guardado de la configuración del dispositivo.
 */

const fs = require('fs');
const log = require('electron-log');
const { CONFIG_DIR, CONFIG_FILE_PATH } = require('../config/constants');

/**
 * Carga la configuración del agente desde un archivo JSON.
 * @returns {object} El objeto de configuración o un objeto vacío si falla.
 */
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE_PATH)) {
            const data = fs.readFileSync(CONFIG_FILE_PATH, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        log.error('[CONFIG]: Error al leer/parsear el archivo de configuracion:', error);
    }
    return {};
}

/**
 * Guarda el objeto de configuración en un archivo JSON.
 * @param {object} config - El objeto de configuración a guardar.
 */
function saveConfig(config) {
    try {
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }
        fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(config, null, 2));
    } catch (error) {
        log.error('[CONFIG]: Error al guardar la configuracion:', error);
    }
}

/**
 * Elimina la configuración (para forzar modo provisioning)
 */
function deleteConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE_PATH)) {
            fs.unlinkSync(CONFIG_FILE_PATH);
            log.info('[CONFIG]: Configuracion eliminada.');
        }
    } catch (error) {
        log.error('[CONFIG]: Error al eliminar configuracion:', error);
    }
}

module.exports = {
    loadConfig,
    saveConfig,
    deleteConfig,
};
