/**
 * Auto-Updater - Actualización automática del agente
 * 
 * Gestiona la búsqueda, descarga e instalación de actualizaciones.
 */

const { autoUpdater } = require('electron-updater');
const { log } = require('../utils/logConfig');

// Variable interna para controlar si hay una actualización en curso
let isCheckingForUpdate = false;

/**
 * Configura el autoUpdater con la configuración inicial
 */
function configureUpdater() {
    // Configuración del autoUpdater
    autoUpdater.logger = log;
    autoUpdater.logger.transports.file.level = 'info';

    // Configuración básica de actualización
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    // - Permite downgrade para forzar actualizaciones completas
    // - Desactiva actualizaciones pre-release a menos que sea necesario
    autoUpdater.allowDowngrade = true;
    autoUpdater.allowPrerelease = false;

    // forzar descargas completas y evitar problemas de checksum
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.fullChangelog = true;
}

/**
 * Configura los listeners de electron-updater y busca actualizaciones.
 */
function checkForUpdates() {
    log.info('[UPDATER]: Buscando actualizaciones...');

    // Limpiar listeners anteriores para evitar duplicados
    autoUpdater.removeAllListeners('update-available');
    autoUpdater.removeAllListeners('update-not-available');
    autoUpdater.removeAllListeners('error');
    autoUpdater.removeAllListeners('download-progress');
    autoUpdater.removeAllListeners('update-downloaded');

    autoUpdater.on('update-available', (info) => {
        log.info('[UPDATER]: ¡Actualización disponible! Version:', info.version);
        log.info('[UPDATER]: Iniciando descarga...');

        // Notificar a la ventana de control
        const { BrowserWindow } = require('electron');
        BrowserWindow.getAllWindows().forEach(win => {
            if (win && !win.isDestroyed()) {
                win.webContents.send('update-status', {
                    type: 'downloading',
                    message: `Descargando versión ${info.version}...`
                });
            }
        });
    });

    autoUpdater.on('update-not-available', () => {
        log.info('[UPDATER]: Ya estás en la última versión.');
        isCheckingForUpdate = false;

        // Notificar a la ventana de control
        const { BrowserWindow } = require('electron');
        BrowserWindow.getAllWindows().forEach(win => {
            if (win && !win.isDestroyed()) {
                win.webContents.send('update-status', {
                    type: 'up-to-date',
                    message: 'Agente en la última versión'
                });
            }
        });
    });

    autoUpdater.on('error', (err) => {
        log.error('[UPDATER]: Error en la actualizacion:', err);
        isCheckingForUpdate = false;

        // Notificar error a la ventana de control
        const { BrowserWindow } = require('electron');
        BrowserWindow.getAllWindows().forEach(win => {
            if (win && !win.isDestroyed()) {
                win.webContents.send('update-status', {
                    status: 'error',
                    message: 'Error al buscar actualización'
                });
            }
        });

        // Intentar con una descarga completa después de un error
        if (err.message && err.message.includes('checksum')) {
            log.info('[UPDATER]: Error de checksum. Intentando descarga completa...');
            autoUpdater.autoDownload = true;
            autoUpdater.allowDowngrade = true;
            autoUpdater.checkForUpdates();
        }
    });

    autoUpdater.on('download-progress', (progressObj) => {
        log.info(`[UPDATER]: Descargando: ${Math.round(progressObj.percent)}%`);
    });

    autoUpdater.on('update-downloaded', (info) => {
        log.info('[UPDATER]: Actualizacion descargada. Version:', info.version);
        log.info('[UPDATER]: La actualizacion se instalará al reiniciar la aplicación.');

        // Notificar a la ventana de control
        const { BrowserWindow } = require('electron');
        BrowserWindow.getAllWindows().forEach(win => {
            if (win && !win.isDestroyed()) {
                win.webContents.send('update-status', {
                    type: 'downloaded',
                    message: 'Actualización descargada. Reiniciando...'
                });
            }
        });

        // Forzar la instalación después de 5 segundos
        setTimeout(() => {
            autoUpdater.quitAndInstall(true, true);
        }, 5000);
    });

    // Permitir web installers (stub) para auto-updates
    autoUpdater.disableWebInstaller = false;
    autoUpdater.allowDowngrade = true;

    // Iniciar la búsqueda de actualizaciones
    autoUpdater.checkForUpdates().catch(error => {
        log.error('[UPDATER]: Error al buscar actualizaciones:', error);
        isCheckingForUpdate = false;
    });

    // REINTENTO PERIODICO
    // Si la app está rota, intentará cada 10 min.
    setInterval(() => {
        if (!isCheckingForUpdate) {
            log.info('[UPDATER]: Re-intento periódico de búsqueda de actualización...');
            autoUpdater.checkForUpdates().catch(() => { });
        }
    }, 10 * 60 * 1000);
}

/**
 * Verifica si hay una actualización en curso
 */
function isUpdating() {
    return isCheckingForUpdate;
}

/**
 * Marca que se está buscando una actualización
 */
function setUpdating(value) {
    isCheckingForUpdate = value;
}

/**
 * Fuerza búsqueda inmediata de actualizaciones.
 * Incluye cooldown de 3 minutos para evitar spam de requests.
 */
function handleForceUpdate() {
    if (isCheckingForUpdate) {
        log.info('[COMMAND-UPDATE]: Ignorando comando "force_update": ya hay una busqueda de actualizacion en curso.');
        return;
    }
    log.info('[COMMAND-UPDATE]: Received force_update command. Checking for updates now...');

    isCheckingForUpdate = true;

    autoUpdater.checkForUpdatesAndNotify();

    setTimeout(() => {
        log.info('[COMMAND-UPDATE]: Cooldown de actualizacion finalizado. Se permiten nuevas busquedas.');
        isCheckingForUpdate = false;
    }, 3 * 60 * 1000);
}

module.exports = {
    configureUpdater,
    checkForUpdates,
    isUpdating,
    setUpdating,
    handleForceUpdate,
};
