/**
 * State Service
 * Gestiona mapeo de pantallas y persistencia de estado
 */

const { screen } = require('electron');
const fs = require('fs');
const { log } = require('../utils/logConfig');
const { STATE_FILE_PATH } = require('../config/constants');

// Construye mapa de pantallas ordenado por posición
async function buildDisplayMap(hardwareIdToDisplayMap) {
    hardwareIdToDisplayMap.clear();
    const displays = screen.getAllDisplays();

    // Ordena pantallas por posición X (izquierda a derecha)
    displays.sort((a, b) => a.bounds.x - b.bounds.x);

    displays.forEach((display, index) => {
        const simpleId = String(index + 1);
        hardwareIdToDisplayMap.set(simpleId, display);
    });

    log.info('[DISPLAY_MAP]: Mapa de pantallas actualizado:', Array.from(hardwareIdToDisplayMap.keys()));
}

// Carga último estado desde archivo JSON
function loadLastState() {
    try {
        if (fs.existsSync(STATE_FILE_PATH)) {
            const state = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf8')) || {};
            const migratedState = {};
            for (const [key, value] of Object.entries(state)) {
                if (typeof value === 'string') {
                    migratedState[key] = {
                        url: value,
                        credentials: null,
                        timestamp: new Date().toISOString()
                    };
                } else {
                    migratedState[key] = value;
                }
            }
            if (JSON.stringify(state) !== JSON.stringify(migratedState)) {
                fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(migratedState, null, 2));
            }
            return migratedState;
        }
    } catch (error) {
        log.error('[STATE]: Error al leer o parsear el archivo de estado:', error);
    }
    return {};
}

/**
 * Limpia el estado de pantallas que ya no existen.
 * @param {Map} hardwareIdToDisplayMap
 */
function cleanOrphanedState(hardwareIdToDisplayMap) {
    const state = loadLastState();
    const validIds = Array.from(hardwareIdToDisplayMap.keys());
    const cleanedState = {};

    for (const [id, url] of Object.entries(state)) {
        if (validIds.includes(id)) {
            cleanedState[id] = url;
        } else {
            log.info(`[STATE]: Limpiando entrada huérfana para pantalla inexistente: ${id}`);
        }
    }

    try {
        fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(cleanedState, null, 2));
    } catch (error) {
        log.error('[STATE]: Error al limpiar estado huérfano:', error);
    }

    return cleanedState;
}

/**
 * Configura un timer de auto-refresh para una pantalla específica.
 */
function setupAutoRefresh(screenIndex, intervalMinutes, managedWindows, autoRefreshTimers) {
    const intervalMs = intervalMinutes * 60 * 1000;

    log.info(`[AUTO-REFRESH]: Configurando auto-refresh cada ${intervalMinutes} minutos para pantalla ${screenIndex}`);

    const timerId = setInterval(() => {
        const win = managedWindows.get(screenIndex);
        if (win && !win.isDestroyed()) {
            log.info(`[AUTO-REFRESH]: Recargando pantalla ${screenIndex} (programado cada ${intervalMinutes}min)`);
            win.webContents.reload();
        } else {
            log.info(`[AUTO-REFRESH]: Ventana ${screenIndex} no existe, limpiando timer`);
            clearInterval(timerId);
            autoRefreshTimers.delete(screenIndex);
        }
    }, intervalMs);

    autoRefreshTimers.set(screenIndex, timerId);
}

/**
 * Guarda el estado actual de una pantalla.
 */
function saveCurrentState(screenIndex, url, credentials, refreshInterval, autoRefreshTimers, managedWindows) {
    let state = loadLastState();

    if (autoRefreshTimers.has(screenIndex)) {
        clearInterval(autoRefreshTimers.get(screenIndex));
        autoRefreshTimers.delete(screenIndex);
        log.info(`[AUTO-REFRESH]: Timer limpiado para pantalla ${screenIndex}`);
    }

    if (url) {
        state[screenIndex] = {
            url: url,
            credentials: credentials || null,
            refreshInterval: refreshInterval || 0,
            timestamp: new Date().toISOString()
        };

        if (refreshInterval > 0) {
            setupAutoRefresh(screenIndex, refreshInterval, managedWindows, autoRefreshTimers);
        }
    } else {
        delete state[screenIndex];
    }

    try {
        fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2));
        log.info(`[STATE]: Estado guardado para pantalla ${screenIndex}: ${url || '(vacío)'}${refreshInterval ? ` (auto-refresh: ${refreshInterval}min)` : ''}`);
    } catch (error) {
        log.error('[STATE]: Error al guardar estado:', error);
    }
}

/**
 * Restaura las URLs guardadas.
 */
function restoreLastState(hardwareIdToDisplayMap, handleShowUrlCallback) {
    log.info('[STATE]: Iniciando restauracion de estado...');
    const lastState = cleanOrphanedState(hardwareIdToDisplayMap);

    if (Object.keys(lastState).length === 0) {
        log.info('[STATE]: No hay estado previo para restaurar (archivo vacio o no existe).');
        return;
    }

    log.info('[STATE]: Restaurando ultimo estado conocido:', JSON.stringify(lastState, null, 2));

    let restoredCount = 0;
    for (const [stableId, screenData] of Object.entries(lastState)) {
        if (hardwareIdToDisplayMap.has(stableId)) {
            log.info(`[STATE]: Restaurando pantalla ${stableId} con URL: ${screenData.url}${screenData.refreshInterval ? ` (auto-refresh: ${screenData.refreshInterval}min)` : ''}`);
            const command = {
                action: 'show_url',
                screenIndex: stableId,
                url: screenData.url,
                credentials: screenData.credentials || null,
                refreshInterval: screenData.refreshInterval || 0
            };

            setTimeout(() => {
                handleShowUrlCallback(command);
            }, 500 * restoredCount);
            restoredCount++;
        }
    }

    log.info(`[STATE]: Restauracion completada. ${restoredCount} pantallas restauradas.`);
}

module.exports = {
    buildDisplayMap,
    loadLastState,
    cleanOrphanedState,
    setupAutoRefresh,
    saveCurrentState,
    restoreLastState
};
