/**
 * Gestión de GPU y aceleración de hardware
 * 
 * Detecta automáticamente si la GPU funciona correctamente y
 * cambia a renderizado por software si es necesario.
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const log = require('electron-log');

const GPU_CONFIG_FILE = path.join(app.getPath('userData'), 'gpu-config.json');

// Verifica si la GPU falló anteriormente
function hasGpuFailed() {
    try {
        if (fs.existsSync(GPU_CONFIG_FILE)) {
            const config = JSON.parse(fs.readFileSync(GPU_CONFIG_FILE, 'utf8'));
            return config.gpuFailed === true;
        }
    } catch (e) { /* Ignora errores de lectura */ }
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

// Resetea el estado de GPU (para pruebas o después de actualizar drivers)
function resetGpuState() {
    try {
        if (fs.existsSync(GPU_CONFIG_FILE)) {
            fs.unlinkSync(GPU_CONFIG_FILE);
        }
    } catch (e) { /* Ignorar */ }
}

// Configura GPU según disponibilidad
function configureGpu() {
    if (hasGpuFailed()) {
        log.info('[GPU]: GPU marcada como fallida anteriormente. Usando renderizado por software.');
        app.disableHardwareAcceleration();
    } else {
        log.info('[GPU]: Usando aceleracion de hardware...');
        // Solo habilita opciones seguras
        app.commandLine.appendSwitch('enable-gpu-rasterization');
    }
}

// Optimizaciones de memoria
function configureMemory() {
    app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512');
    app.commandLine.appendSwitch('disk-cache-size', '10485760'); // 10MB
    app.commandLine.appendSwitch('media-cache-size', '10485760'); // 10MB
    app.commandLine.appendSwitch('disable-extensions');
    app.commandLine.appendSwitch('disable-sync');
    app.commandLine.appendSwitch('disable-translate');
    app.commandLine.appendSwitch('disable-background-networking');
}

// Registra listeners para detectar crash de GPU
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
