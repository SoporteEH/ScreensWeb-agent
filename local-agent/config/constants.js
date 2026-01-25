/**
 * Configuration Constants
 * Maneja configuración de desarrollo y producción
 */

const { app } = require('electron');
const path = require('path');


require('dotenv').config({ path: path.join(__dirname, '..', '.env') });


const { loadConfig } = require('../utils/configManager');

// SERVER_URL se carga dinámicamente desde el store si existe
const config = loadConfig();
let SERVER_URL = config.serverUrl || process.env.SERVER_URL;

if (!SERVER_URL) {
    try {
        const packageJson = require('../package.json');
        SERVER_URL = packageJson.config?.serverUrl;
    } catch (e) {
        // Ignorar error de carga
    }
}


const CONFIG_DIR = path.join(app.getPath('userData'), 'ScreensWeb');
const CONFIG_FILE_PATH = path.join(CONFIG_DIR, 'config.json');
const STATE_FILE_PATH = path.join(CONFIG_DIR, 'state.json');
const CONTENT_DIR = path.join(CONFIG_DIR, 'content');


const AGENT_REFRESH_URL = SERVER_URL ? `${SERVER_URL}/api/auth/agent-refresh` : '';
const SYNC_API_URL = SERVER_URL ? `${SERVER_URL}/api/users/me/local-assets` : '';


const CONSTANTS = {
    HEARTBEAT_INTERVAL_MS: 30 * 1000,           // Heartbeat cada 30 segundos
    TOKEN_CHECK_INTERVAL_MS: 4 * 60 * 60 * 1000, // Verifica token cada 4 horas
    UPDATE_CHECK_MIN_DELAY_MS: 15000,            // Delay mínimo antes de buscar updates
    UPDATE_CHECK_MAX_DELAY_MS: 60000,            // Delay máximo antes de buscar updates
    SCREEN_DEBOUNCE_MS: 500,                     // Debounce para cambios de pantalla
    RETRY_BACKOFF_BASE_MS: 30 * 1000,            // Base para backoff exponencial
    MAX_RETRIES: 5,                              // Máximo de reintentos
    GC_INTERVAL_MS: 4 * 60 * 60 * 1000,          // Garbage collection cada 4 horas
    NETWORK_CHECK_INTERVAL_MS: 10 * 1000,        // Monitoreo de red cada 10 segundos
    SOCKET_RECONNECT_DELAY_MAX_MS: 60 * 1000,    // Máximo delay entre reconexiones
};


let AGENT_VERSION = 'Unknown';
try {
    const packageJson = require('../package.json');
    AGENT_VERSION = packageJson.version;
} catch (e) {
    console.error('[CONFIG]: No se pudo leer la versión del package.json');
}


// Helper para obtener la URL del servidor actualizada
function getServerUrl() {
    const freshConfig = loadConfig();
    return freshConfig.serverUrl || SERVER_URL;
}

module.exports = {
    SERVER_URL,
    getServerUrl,
    CONFIG_DIR,
    CONFIG_FILE_PATH,
    STATE_FILE_PATH,
    CONTENT_DIR,
    AGENT_REFRESH_URL,
    SYNC_API_URL,
    CONSTANTS,
    AGENT_VERSION,
};

