const { net } = require('electron');
const EventEmitter = require('events');
const path = require('path');
const { log } = require('../utils/logConfig');

/**
 * Network Monitor Service
 * Actively checks for internet connectivity and notifies the system
 * to trigger Fallback or Recovery actions.
 */
class NetworkMonitor extends EventEmitter {
    constructor(context) {
        super();
        this.context = context;
        this.isOnline = true;
        this.checkInterval = null;
        this.fallbackPath = `file://${path.join(__dirname, '../fallback.html')}`;
    }

    /**
     * Start the polling monitor.
     */
    start(intervalMs = 5000) {
        this.checkInterval = setInterval(() => this.check(), intervalMs);
        log.info(`[NETWORK]: Monitor iniciado (Intervalo: ${intervalMs}ms)`);
    }

    /**
     * Perform a connectivity check and trigger events/actions on change.
     */
    async check() {
        const currentlyOnline = net.isOnline();

        if (currentlyOnline !== this.isOnline) {
            this.isOnline = currentlyOnline;
            if (this.isOnline) {
                log.info('[NETWORK]: Conexion restaurada.');
                await this.handleRecovery();
            } else {
                log.warn('[NETWORK]: Conexion perdida.');
                await this.handleFallback();
            }
            this.emit(this.isOnline ? 'network-online' : 'network-offline');
        }
    }

    /**
     * Fallback Logic: Switch remote windows to fallback.html
     */
    async handleFallback() {
        log.info('[RESILIENCE]: Aplicando Fallback a contenido remoto...');
        for (const [screenId, win] of this.context.managedWindows.entries()) {
            if (!win || win.isDestroyed()) continue;

            const currentUrl = win.webContents.getURL();

            // STRICT FILTERING: Only fallback if current content is remote (http/https)
            // or if the window is already in a failed state (showing fallback but intended to be remote)
            if (currentUrl.startsWith('http')) {
                log.info(`[RESILIENCE]: Pantalla ${screenId} -> Fallback (Offline)`);
                win.loadURL(this.fallbackPath);
            }
        }
    }

    /**
     * Recovery Logic: Reload original remote URLs once online
     */
    async handleRecovery() {
        log.info('[RESILIENCE]: Iniciando recuperacion de pantallas...');

        for (const [screenId, win] of this.context.managedWindows.entries()) {
            if (!win || win.isDestroyed()) continue;

            const currentUrl = win.webContents.getURL();

            // We only need to recover windows showing the fallback
            if (currentUrl === this.fallbackPath) {
                log.info(`[RESILIENCE]: Pantalla ${screenId} -> Recuperando contenido original...`);

                // CRITICAL: Clear any pending retries to avoid collision/flickering
                if (this.context.retryManager && this.context.retryManager.has(screenId)) {
                    const retry = this.context.retryManager.get(screenId);
                    if (retry.timerId) clearTimeout(retry.timerId);
                    this.context.retryManager.delete(screenId);
                }

                // Force a reload using the last known state
                // This will use handleShowUrl which will use the state data
                this.emit('recover-screen', screenId);
            }
        }
    }
}

module.exports = NetworkMonitor;
