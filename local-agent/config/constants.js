/**
 * Constantes y configuración del agente ScreensWeb
 * 
 * - Desarrollo: usa .env con dotenv
 * - Producción: variables inyectadas en tiempo de build
 */

const { app } = require('electron');
const path = require('path');

// Carga variables de entorno desde .env (desarrollo)
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// En desarrollo: definir en .env
// En producción: inyectar via electron-builder en package.json
const SERVER_URL = process.env.SERVER_URL;

if (!SERVER_URL) {
    console.error('='.repeat(60));
    console.error('ERROR: SERVER_URL no está configurado.');
    console.error('');
    console.error('Para desarrollo:');
    console.error('  1. Copia .env.example a .env');
    console.error('  2. Configura SERVER_URL=http://tu-servidor:3000');
    console.error('');
    console.error('Para producción:');
    console.error('  Configura SERVER_URL en el build de electron-builder');
    console.error('='.repeat(60));
}

// RUTAS DE DIRECTORIOS Y ARCHIVOS
const CONFIG_DIR = path.join(app.getPath('userData'), 'ScreensWeb');
const CONFIG_FILE_PATH = path.join(CONFIG_DIR, 'config.json');
const STATE_FILE_PATH = path.join(CONFIG_DIR, 'state.json');
const CONTENT_DIR = path.join(CONFIG_DIR, 'content');

// URLs de la API
const AGENT_REFRESH_URL = SERVER_URL ? `${SERVER_URL}/api/auth/agent-refresh` : '';
const SYNC_API_URL = SERVER_URL ? `${SERVER_URL}/api/users/me/local-assets` : '';

// Constantes de tiempo (milisegundos)
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

// Versión del agente
let AGENT_VERSION = 'Unknown';
try {
    const packageJson = require('../package.json');
    AGENT_VERSION = packageJson.version;
} catch (e) {
    console.error('[CONFIG]: No se pudo leer la versión del package.json');
}

// EXPORTS
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

