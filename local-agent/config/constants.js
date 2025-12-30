/**
 * Constantes y configuración del agente ScreensWeb
 * 
 * Este módulo centraliza todas las constantes, rutas y configuración.
 * Se importan en main.js para mantener el código organizado.
 */

const { app } = require('electron');
const path = require('path');

// =============================================================================
// URL DEL SERVIDOR
// =============================================================================
const SERVER_URL = process.env.SERVER_URL || 'http://192.168.1.134:3000';

// =============================================================================
// RUTAS DE DIRECTORIOS Y ARCHIVOS
// =============================================================================
const CONFIG_DIR = path.join(app.getPath('userData'), 'ScreensWeb');
const CONFIG_FILE_PATH = path.join(CONFIG_DIR, 'config.json');
const STATE_FILE_PATH = path.join(CONFIG_DIR, 'state.json');
const CONTENT_DIR = path.join(CONFIG_DIR, 'content');

// =============================================================================
// URLs DE LA API
// =============================================================================
const AGENT_REFRESH_URL = `${SERVER_URL}/api/auth/agent-refresh`;
const SYNC_API_URL = `${SERVER_URL}/api/users/me/local-assets`;

// =============================================================================
// CONSTANTES DE TIEMPO (en milisegundos)
// =============================================================================
const CONSTANTS = {
    HEARTBEAT_INTERVAL_MS: 30 * 1000,           // Heartbeat cada 30 segundos
    TOKEN_CHECK_INTERVAL_MS: 4 * 60 * 60 * 1000, // Verificar token cada 4 horas
    UPDATE_CHECK_MIN_DELAY_MS: 15000,            // Delay mínimo antes de buscar updates
    UPDATE_CHECK_MAX_DELAY_MS: 60000,            // Delay máximo antes de buscar updates
    SCREEN_DEBOUNCE_MS: 500,                     // Debounce para cambios de pantalla
    RETRY_BACKOFF_BASE_MS: 30 * 1000,            // Base para backoff exponencial
    MAX_RETRIES: 5,                              // Máximo de reintentos
    GC_INTERVAL_MS: 4 * 60 * 60 * 1000,          // Garbage collection cada 4 horas
    NETWORK_CHECK_INTERVAL_MS: 10 * 1000,        // Monitoreo de red cada 10 segundos
    SOCKET_RECONNECT_DELAY_MAX_MS: 60 * 1000,    // Máximo delay entre reconexiones
};

// =============================================================================
// VERSIÓN DEL AGENTE
// =============================================================================
let AGENT_VERSION = 'Unknown';
try {
    const packageJson = require('../package.json');
    AGENT_VERSION = packageJson.version;
} catch (e) {
    console.error('[CONFIG]: No se pudo leer la versión del package.json');
}

// =============================================================================
// EXPORTS
// =============================================================================
module.exports = {
    SERVER_URL,
    CONFIG_DIR,
    CONFIG_FILE_PATH,
    STATE_FILE_PATH,
    CONTENT_DIR,
    AGENT_REFRESH_URL,
    SYNC_API_URL,
    CONSTANTS,
    AGENT_VERSION,
};
