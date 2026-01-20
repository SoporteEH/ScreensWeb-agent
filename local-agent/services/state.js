const { screen } = require('electron');
const fs = require('fs');
const { log } = require('../utils/logConfig');
const { STATE_FILE_PATH } = require('../config/constants');

/**
 * Build display map ordered by physical position (left-to-right).
 */
async function buildDisplayMap(hardwareIdToDisplayMap) {
    hardwareIdToDisplayMap.clear();
    const displays = screen.getAllDisplays();

    // Sort by X position for consistent screen numbering
    displays.sort((a, b) => a.bounds.x - b.bounds.x);

    displays.forEach((display, index) => {
        const simpleId = String(index + 1);
        hardwareIdToDisplayMap.set(simpleId, display);
    });

    log.info('[DISPLAY_MAP]: Mapa de pantallas actualizado:', Array.from(hardwareIdToDisplayMap.keys()));
}

/**
 * Load persisted state from disk. Handles migration from old string-only states.
 */
function loadLastState() {
    try {
        if (fs.existsSync(STATE_FILE_PATH)) {
            const state = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf8')) || {};
            const migratedState = {};

            for (const [key, value] of Object.entries(state)) {
                // Ensure state matches the current rich object format
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
            return migratedState;
        }
    } catch (error) {
        log.error('[STATE]: Error al leer el archivo de estado:', error);
    }
    return {};
}

/**
 * Remove entries for monitors that are no longer physically connected.
 */
function cleanOrphanedState(hardwareIdToDisplayMap) {
    const state = loadLastState();
    const validIds = Array.from(hardwareIdToDisplayMap.keys());
    const cleanedState = {};

    for (const [id, data] of Object.entries(state)) {
        if (validIds.includes(id)) {
            cleanedState[id] = data;
        } else {
            log.info(`[STATE]: Limpiando entrada huerfana para pantalla ${id}`);
        }
    }
    return cleanedState;
}

/**
 * Setup a recursive refresh timer for a specific window.
 */
function setupAutoRefresh(screenIndex, intervalMinutes, managedWindows, autoRefreshTimers) {
    const intervalMs = intervalMinutes * 60 * 1000;

    const timerId = setInterval(() => {
        const win = managedWindows.get(screenIndex);
        if (win && !win.isDestroyed()) {
            win.webContents.reload();
        } else {
            clearInterval(timerId);
            autoRefreshTimers.delete(screenIndex);
        }
    }, intervalMs);

    autoRefreshTimers.set(screenIndex, timerId);
}

/**
 * Save current screen configuration and manage auto-refresh timers.
 */
function saveCurrentState(screenIndex, url, credentials, refreshInterval, autoRefreshTimers, managedWindows, contentName) {
    let state = loadLastState();

    // Reset previous timer for this slot
    if (autoRefreshTimers.has(screenIndex)) {
        clearInterval(autoRefreshTimers.get(screenIndex));
        autoRefreshTimers.delete(screenIndex);
    }

    if (url) {
        state[screenIndex] = {
            url: url,
            contentName: contentName || null,
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
        const dir = require('path').dirname(STATE_FILE_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2));
    } catch (error) {
        log.error('[STATE]: Error al guardar estado:', error);
    }
}

/**
 * Re-launch content windows based on the last saved session state.
 */
function restoreLastState(hardwareIdToDisplayMap, handleShowUrlCallback) {
    log.info('[STATE]: Restaurando sesion...');
    const lastState = cleanOrphanedState(hardwareIdToDisplayMap);

    if (Object.keys(lastState).length === 0) return;

    let restoredCount = 0;
    for (const [stableId, screenData] of Object.entries(lastState)) {
        if (hardwareIdToDisplayMap.has(stableId)) {
            const command = {
                action: 'show_url',
                screenIndex: stableId,
                url: screenData.url,
                credentials: screenData.credentials || null,
                refreshInterval: screenData.refreshInterval || 0,
                contentName: screenData.contentName || null
            };

            // Stagger loading to prevent resource spikes at boot
            setTimeout(() => {
                handleShowUrlCallback(command);
            }, 500 * restoredCount);
            restoredCount++;
        }
    }
}

module.exports = {
    buildDisplayMap,
    loadLastState,
    cleanOrphanedState,
    setupAutoRefresh,
    saveCurrentState,
    restoreLastState
};
