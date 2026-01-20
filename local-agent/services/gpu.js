const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { log } = require('../utils/logConfig');

const GPU_CONFIG_FILE = path.join(app.getPath('userData'), 'gpu-config.json');

/**
 * Persistence for GPU failure state.
 * Prevents continuous crashing by disabling hardware acceleration if needed.
 */
function hasGpuFailed() {
    try {
        if (fs.existsSync(GPU_CONFIG_FILE)) {
            const config = JSON.parse(fs.readFileSync(GPU_CONFIG_FILE, 'utf8'));
            return config.gpuFailed === true;
        }
    } catch (e) { }
    return false;
}

function markGpuAsFailed() {
    try {
        fs.writeFileSync(GPU_CONFIG_FILE, JSON.stringify({
            gpuFailed: true,
            failedAt: new Date().toISOString()
        }));
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

/**
 * Determine if hardware acceleration should be enabled.
 */
function configureGpu() {
    if (hasGpuFailed()) {
        log.info('[GPU]: Fallo anterior detectado. Usando renderizado por software (Fallback).');
        app.disableHardwareAcceleration();
    } else {
        log.info('[GPU]: Usando aceleracion de hardware...');
        app.commandLine.appendSwitch('enable-gpu-rasterization');
    }
}

/**
 * Constrains Chromium processes to prevent system-wide slowdowns.
 */
function configureMemory() {
    // JavaScript limits
    app.commandLine.appendSwitch('js-flags', '--max-old-space-size=384 --max-semi-space-size=2');

    // Process limits
    app.commandLine.appendSwitch('renderer-process-limit', '3');

    // Cache limits (5MB)
    app.commandLine.appendSwitch('disk-cache-size', '5242880');
    app.commandLine.appendSwitch('media-cache-size', '5242880');

    // Disable resource-heavy features
    app.commandLine.appendSwitch('disable-http-cache');
    app.commandLine.appendSwitch('disable-features', 'MediaRouter,AudioServiceOutOfProcess,CalculateNativeWinOcclusion,HardwareMediaKeyHandling');
    app.commandLine.appendSwitch('disable-extensions');
    app.commandLine.appendSwitch('disable-sync');
    app.commandLine.appendSwitch('disable-translate');
    app.commandLine.appendSwitch('disable-background-networking');
    app.commandLine.appendSwitch('disable-notifications');
    app.commandLine.appendSwitch('disable-domain-reliability');
}

/**
 * Handle unexpected GPU or renderer crashes.
 */
function registerGpuCrashHandlers() {
    app.on('gpu-process-crashed', (event, killed) => {
        log.error(`[GPU]: Proceso GPU crasheo (killed: ${killed}). Marcando para fallback.`);
        markGpuAsFailed();
    });

    app.on('render-process-gone', (event, webContents, details) => {
        if (details.reason === 'crashed' || details.reason === 'gpu-dead') {
            log.error(`[GPU]: Renderizado fallo (razon: ${details.reason}). Marcando GPU como fallida.`);
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
