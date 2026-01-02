/**
  Log Configuration
 * 
 * - Rotación automática de logs por tamaño
 * - Retención limitada (últimos 7 archivos)
 * - Separación por tipo (main, updater, heartbeat)
 */

const log = require('electron-log');
const path = require('path');

// Configuración general
log.transports.file.level = 'info';
log.transports.console.level = 'debug';

// Rotación automática
log.transports.file.maxSize = 10 * 1024 * 1024;
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';

// Mantiene los últimos 7 archivos de log
log.transports.file.archiveLog = (oldPath) => {
    const info = path.parse(oldPath);
    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    return path.join(info.dir, `${info.name}.${timestamp}${info.ext}`);
};

// Limpia logs viejos
function cleanOldLogs() {
    const fs = require('fs');
    const logDir = path.dirname(log.transports.file.getFile().path);
    const maxAge = 7 * 24 * 60 * 60 * 1000;

    try {
        const files = fs.readdirSync(logDir);
        const now = Date.now();

        files.forEach(file => {
            if (file.startsWith('main') && file.endsWith('.log')) {
                const filePath = path.join(logDir, file);
                const stats = fs.statSync(filePath);

                // Borrar si es más viejo que 7 días
                if (now - stats.mtimeMs > maxAge) {
                    fs.unlinkSync(filePath);
                    log.info(`[CLEANUP]: Log antiguo eliminado: ${file}`);
                }
            }
        });
    } catch (error) {
        log.error('[CLEANUP]: Error limpiando logs:', error);
    }
}

// Limpiar logs viejos al iniciar
cleanOldLogs();

// Limpiar logs viejos cada 24 horas
setInterval(cleanOldLogs, 24 * 60 * 60 * 1000);

// Logger heartbeats 
const heartbeatLog = {
    _counter: 0,
    _lastLog: 0,

    // log cada 10 heartbeats
    info: function (message) {
        this._counter++;
        const now = Date.now();

        if (this._counter % 10 === 0 || now - this._lastLog > 5 * 60 * 1000) {
            log.debug(`[HEARTBEAT]: Latidos enviados (últimos 5 min): ${this._counter % 10 || 10}`);
            this._lastLog = now;
        }
    }
};

// Logger para updater 
const updaterLog = {
    _lastUpdateCheck: 0,

    logCheck: function (version) {
        const now = Date.now();

        if (now - this._lastUpdateCheck > 10 * 60 * 1000) {
            log.info(`[UPDATER]: Verificación periódica - Versión actual: ${version}`);
            this._lastUpdateCheck = now;
        }
    },

    logUpdate: function (message) {
        log.info(`[UPDATER]: ${message}`);
    }
};

module.exports = {
    log,
    heartbeatLog,
    updaterLog,
    cleanOldLogs
};
