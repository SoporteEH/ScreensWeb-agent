const { screen, net } = require('electron');
const { log } = require('../utils/logConfig');
const { startNetworkMonitoring: startNetworkService } = require('./network');
const { buildDisplayMap, loadLastState } = require('./state');

let screenChangeTimeout;

/**
 * Inicializa los monitores de hardware y red.
 */
const initializeMonitors = (context) => {
    // Escuchar cambios de pantalla
    const onScreenChange = (reason) => {
        const { hardwareIdToDisplayMap, managedWindows, handleShowUrl, socket, registerDevice, CONSTANTS } = context;
        if (screenChangeTimeout) clearTimeout(screenChangeTimeout);
        log.info(`[DISPLAY]: Detectado cambio de pantalla (${reason}). Esperando estabilización...`);

        screenChangeTimeout = setTimeout(async () => {
            log.info('[DISPLAY]: Entorno estabilizado. Actualizando mapa de pantallas.');

            const previousScreenIds = Array.from(hardwareIdToDisplayMap.keys());
            await buildDisplayMap(hardwareIdToDisplayMap);
            const currentScreenIds = Array.from(hardwareIdToDisplayMap.keys());

            if (reason === 'removed') {
                const orphanedIds = previousScreenIds.filter(id => !currentScreenIds.includes(id));
                for (const orphanedId of orphanedIds) {
                    const win = managedWindows.get(orphanedId);
                    if (win && !win.isDestroyed()) {
                        log.info(`[DISPLAY]: Cerrando ventana huerfana para pantalla ${orphanedId}`);
                        win.close();
                    }
                    managedWindows.delete(orphanedId);
                }
            }

            if (reason === 'added') {
                const newScreenIds = currentScreenIds.filter(id => !previousScreenIds.includes(id));
                if (newScreenIds.length > 0) {
                    log.info(`[DISPLAY]: Nuevas pantallas detectadas: ${newScreenIds.join(', ')}`);
                    const lastState = loadLastState();
                    for (const newId of newScreenIds) {
                        if (lastState[newId]) {
                            const screenData = lastState[newId];
                            log.info(`[DISPLAY]: Restaurando contenido en pantalla ${newId}: ${screenData.url}`);
                            setTimeout(() => {
                                handleShowUrl({
                                    action: 'show_url',
                                    screenIndex: newId,
                                    url: screenData.url,
                                    credentials: screenData.credentials || null
                                });
                            }, 500);
                        }
                    }
                }
            }

            if (socket && socket.connected) {
                registerDevice();
            }
        }, CONSTANTS.SCREEN_DEBOUNCE_MS);
    };

    screen.on('display-added', () => onScreenChange('added'));
    screen.on('display-removed', () => onScreenChange('removed'));
    screen.on('display-metrics-changed', () => onScreenChange('metrics-changed'));

    // NETWORK MONITORING
    startNetworkService({
        onOffline: () => context.onNetworkOffline(),
        onOnline: () => context.onNetworkOnline(),
        onCheckOnline: () => {
            if (context.socket && !context.socket.connected) {
                log.info('[NETWORK]: Red online pero socket desconectado. Forzando reconexion...');
                context.socket.connect();
            }
        }
    });
};

module.exports = { initializeMonitors };
