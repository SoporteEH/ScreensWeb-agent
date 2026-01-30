/**
 * GPU Management Service
 * Detecta y gestiona aceleración por hardware
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { log } = require('../utils/logConfig');

const GPU_CONFIG_FILE = path.join(app.getPath('userData'), 'gpu-config.json');

// Verifica si la GPU falló anteriormente
function hasGpuFailed() {
    try {
        if (fs.existsSync(GPU_CONFIG_FILE)) {
            const config = JSON.parse(fs.readFileSync(GPU_CONFIG_FILE, 'utf8'));
            return config.gpuFailed === true;
        }
    } catch (e) { }
    return false;
}

// Marca la GPU como fallida para futuros inicios
function markGpuAsFailed() {
    try {
        fs.writeFileSync(GPU_CONFIG_FILE, JSON.stringify({ gpuFailed: true, failedAt: new Date().toISOString() }));
        log.info('[GPU]: Marcada como fallida. Proximo inicio usara renderizado por software.');
    } catch (e) {
        log.error('[GPU]: Error guardando estado:', e);
    }
}


function resetGpuState() {
    try {
        if (fs.existsSync(GPU_CONFIG_FILE)) {
            fs.unlinkSync(GPU_CONFIG_FILE);
        }
    } catch (e) { }
}


function configureGpu() {
    if (hasGpuFailed()) {
        log.info('[GPU]: GPU marcada como fallida anteriormente. Usando renderizado por software.');
        app.disableHardwareAcceleration();
    } else {
        log.info('[GPU]: Usando aceleracion de hardware...');

        app.commandLine.appendSwitch('enable-gpu-rasterization');
    }
}


function configureMemory() {
    // Limitar heap de JavaScript a 384MB (reducido de 512MB)
    app.commandLine.appendSwitch('js-flags', '--max-old-space-size=384 --max-semi-space-size=2');

    // Limitar número de procesos renderer a 3
    app.commandLine.appendSwitch('renderer-process-limit', '3');

    // Reducir cachés a 5MB cada uno (antes 10MB)
    app.commandLine.appendSwitch('disk-cache-size', '5242880');
    app.commandLine.appendSwitch('media-cache-size', '5242880');

    // Deshabilitar caché HTTP
    app.commandLine.appendSwitch('disable-http-cache');

    // Deshabilitar features innecesarias de Chromium
    app.commandLine.appendSwitch('disable-features',
        'MediaRouter,AudioServiceOutOfProcess,CalculateNativeWinOcclusion,HardwareMediaKeyHandling');

    // Deshabilitar servicios no utilizados
    app.commandLine.appendSwitch('disable-extensions');
    app.commandLine.appendSwitch('disable-sync');
    app.commandLine.appendSwitch('disable-translate');
    app.commandLine.appendSwitch('disable-background-networking');
    app.commandLine.appendSwitch('disable-notifications');
    app.commandLine.appendSwitch('disable-domain-reliability');

    log.info('[MEMORY]: ización de memoria aplicada');
}


function registerGpuCrashHandlers() {
    app.on('gpu-process-crashed', (event, killed) => {
        log.error(`[GPU]: Proceso GPU crasheo (killed: ${killed}). Marcando para fallback.`);
        markGpuAsFailed();
    });

    app.on('render-process-gone', (event, webContents, details) => {
        if (details.reason === 'crashed' || details.reason === 'gpu-dead') {
            log.error(`[GPU]: Proceso de renderizado fallo (razon: ${details.reason}). Marcando GPU como fallida.`);
            markGpuAsFailed();
        }
    });
}

module.exports = {
    hasGpuFailed,
    markGpuAsFailed,
    resetGpuState,
    configureGpu,
    configureMemory,
    registerGpuCrashHandlers,
};
