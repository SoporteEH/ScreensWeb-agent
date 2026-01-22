const log = require('electron-log');
const path = require('path');
const fs = require('fs');

/**
 * Local-only transport since the removal of the socket hook.
 */
log.transports.file.level = 'info';
log.transports.console.level = 'debug';
log.transports.file.maxSize = 10 * 1024 * 1024; // 10MB per file
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';

/**
 * LOG ROTATION
 */
log.transports.file.archiveLogFn = (oldPath) => {
    const info = path.parse(oldPath);
    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    return path.join(info.dir, `${info.name}.${timestamp}${info.ext}`);
};

/**
 * Deletes log files older than 7 days.
 */
function cleanOldLogs() {
    const logDir = path.dirname(log.transports.file.getFile().path);
    const maxAge = 7 * 24 * 60 * 60 * 1000;
    try {
        if (!fs.existsSync(logDir)) return;
        const files = fs.readdirSync(logDir);
        const now = Date.now();
        files.forEach(file => {
            if (file.endsWith('.log')) {
                const filePath = path.join(logDir, file);
                const stats = fs.statSync(filePath);
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

// Initial cleanup and periodic interval (24h)
cleanOldLogs();
setInterval(cleanOldLogs, 24 * 60 * 60 * 1000);

/**
 * Helper object for update-related diagnostic logging.
 */
const updaterLog = {
    _lastUpdateCheck: 0,
    logCheck: function (version) {
        const now = Date.now();
        if (now - this._lastUpdateCheck > 10 * 60 * 1000) {
            log.info(`[UPDATER]: Verificacion periodica - Version actual: ${version}`);
            this._lastUpdateCheck = now;
        }
    },
    logUpdate: function (message) {
        log.info(`[UPDATER]: ${message}`);
    }
};

module.exports = { log, updaterLog, cleanOldLogs };
