const { log } = require('../utils/logConfig');
const { loadConfig } = require('../utils/configManager');
const { startTokenRefreshLoop } = require('./auth');
const { buildDisplayMap, loadLastState } = require('./state');
const { checkForUpdates } = require('./updater');
const { initializeMonitors } = require('./monitors');

/**
 * Inicia el agente en Modo Normal.
 */
const startNormalMode = async (context) => {
    const {
        setDeviceId,
        setAgentToken,
        hardwareIdToDisplayMap,
        restoreAllContent,
        connectSocket,
        CONSTANTS,
        registerDevice,
        sendHeartbeat,
        managedWindows
    } = context;

    const config = loadConfig();
    const deviceId = config.deviceId;
    let agentToken = config.agentToken;

    setDeviceId(deviceId);
    setAgentToken(agentToken);

    log.info(`[NORMAL]: ID de Maquina cargado: ${deviceId}`);

    // Loop de refresco de token
    startTokenRefreshLoop(agentToken, (newToken) => {
        setAgentToken(newToken);
    });

    // Mapeo de hardware
    await buildDisplayMap(hardwareIdToDisplayMap);

    // Restaurar contenido inmediatamente
    restoreAllContent();

    // Conectar WebSocket
    connectSocket(agentToken);

    // Inicializar monitores (Screen, Network)
    initializeMonitors(context);

    // Búsqueda de actualizaciones programada
    const updateDelay = CONSTANTS.UPDATE_CHECK_MIN_DELAY_MS + Math.random() * (CONSTANTS.UPDATE_CHECK_MAX_DELAY_MS - CONSTANTS.UPDATE_CHECK_MIN_DELAY_MS);
    setTimeout(checkForUpdates, updateDelay);

    // Heartbeat loop
    setInterval(sendHeartbeat, CONSTANTS.HEARTBEAT_INTERVAL_MS);

    // GC & Cache cleanup
    setInterval(() => {
        if (managedWindows.size > 0) {
            log.info('[OPTIMIZATION]: Forzando limpieza de caché y storage.');
            managedWindows.forEach(win => {
                if (win && !win.isDestroyed()) {
                    win.webContents.session.clearCache().catch(err => log.error('[OPTIMIZATION] Error al limpiar caché:', err));
                    win.webContents.session.clearStorageData().catch(err => log.error('[OPTIMIZATION] Error al limpiar storage:', err));
                }
            });
        }
    }, CONSTANTS.GC_INTERVAL_MS);
};

/**
 * Inicia el agente en Modo Vinculación (Provisioning).
 */
const startProvisioningMode = (context) => {
    const { startProvisioningHandler } = context;
    log.info('[INIT]: No se encontro configuracion. Iniciando modo vinculacion.');
    return startProvisioningHandler({
        get socket() { return context.socket; }
    });
};

module.exports = { startNormalMode, startProvisioningMode };
