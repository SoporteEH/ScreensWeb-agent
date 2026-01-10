/**
  Log Configuration
 * 
 * - Rotación automática de logs por tamaño
 * - Retención limitada (últimos 7 archivos)
 * - Separación por tipo (main, updater, heartbeat)
 */

const log = require('electron-log');
const path = require('path');


log.transports.file.level = 'info';
log.transports.console.level = 'debug';


log.hooks.push((message, transport) => {
    if (transport !== log.transports.file) return message;
    if (message.level !== 'error' && message.level !== 'warn') return message;

    try {
        const { SERVER_URL, AGENT_VERSION } = require('../config/constants');
        const { loadConfig } = require('./configManager');
        const { net } = require('electron');

        if (!SERVER_URL) return message;

        const config = loadConfig();
        if (!config.deviceId || !config.agentToken) return message;

        const logData = {
            level: message.level,
            message: message.data.map(d => (typeof d === 'object' ? JSON.stringify(d) : d)).join(' '),
            deviceId: config.deviceId,
            agentVersion: AGENT_VERSION,
            timestamp: new Date().toISOString()
        };

        const request = net.request({
            method: 'POST',
            url: `${SERVER_URL}/api/logs`,
            useSessionCookies: false
        });

        request.setHeader('Content-Type', 'application/json');
        request.setHeader('Authorization', `Bearer ${config.agentToken}`);

        request.on('error', () => { });

        request.write(JSON.stringify(logData));
        request.end();

    } catch (e) { }

    return message;
});


log.transports.file.maxSize = 10 * 1024 * 1024;
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';


log.transports.file.archiveLog = (oldPath) => {
    const info = path.parse(oldPath);
    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    return path.join(info.dir, `${info.name}.${timestamp}${info.ext}`);
};


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


cleanOldLogs();


setInterval(cleanOldLogs, 24 * 60 * 60 * 1000);


const heartbeatLog = {
    _counter: 0,
    _lastLog: 0,


    info: function (message) {
        this._counter++;
        const now = Date.now();

        if (this._counter % 10 === 0 || now - this._lastLog > 5 * 60 * 1000) {
            log.debug(`[HEARTBEAT]: Latidos enviados (ultimos 5 min): ${this._counter % 10 || 10}`);
            this._lastLog = now;
        }
    }
};


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
