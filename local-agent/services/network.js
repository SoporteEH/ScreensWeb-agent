const { net } = require('electron');
const EventEmitter = require('events');
const path = require('path');
const { log } = require('../utils/logConfig');
const { loadLastState } = require('./state');

/**
 * Network Monitor Service
 * Chequeo activo (Polling) cada 5s para detectar caídas y recuperaciones.
 */
class NetworkMonitor extends EventEmitter {
    constructor(context) {
        super();
        this.context = context; // { managedWindows, retryManager, etc. }
        this.isOnline = true;   // Asumimos online al arranque
        this.checkInterval = null;
        this.fallbackPath = `file://${path.join(__dirname, '../fallback.html')}`;
    }

    /**
     * Inicia el monitor
     */
    start(intervalMs = 5000) {
        // Chequeo inicial
        this.isOnline = net.isOnline();
        
        this.checkInterval = setInterval(() => this.check(), intervalMs);
        log.info(`[NETWORK]: Monitor iniciado (Polling: ${intervalMs}ms)`);
    }

    /**
     * Comprueba conectividad y gestiona cambios de estado
     */
    async check() {
        const currentlyOnline = net.isOnline();

        if (currentlyOnline !== this.isOnline) {
            this.isOnline = currentlyOnline;
            
            if (this.isOnline) {
                log.info('[NETWORK]: Conexión RECUPERADA (Online). Iniciando recuperación...');
                this.emit('network-online');
                await this.handleRecovery();
            } else {
                log.warn('[NETWORK]: Conexión PERDIDA (Offline). Activando Fallback...');
                this.emit('network-offline');
                await this.handleFallback();
            }
        }
    }

    /**
     * Pone las pantallas remotas en modo Fallback
     */
    async handleFallback() {
        // Leemos el estado real para saber qué debería haber (no lo que hay ahora)
        const lastState = loadLastState();

        for (const [screenId, win] of this.context.managedWindows.entries()) {
            if (!win || win.isDestroyed()) continue;

            const stateData = lastState[String(screenId)];
            // Solo aplicar fallback si la intención original era una URL remota
            if (stateData && stateData.url && stateData.url.startsWith('http')) {
                const currentUrl = win.webContents.getURL();
                // Evitar recargar si ya está en fallback
                if (!currentUrl.includes('fallback.html')) {
                    log.info(`[RESILIENCE]: Pantalla ${screenId} -> Fallback (Offline)`);
                    win.loadURL(this.fallbackPath);
                }
            }
        }
    }

    /**
     * Recupera el contenido original
     */
    async handleRecovery() {
        const lastState = loadLastState();

        for (const [screenId, win] of this.context.managedWindows.entries()) {
            if (!win || win.isDestroyed()) continue;

            const currentUrl = win.webContents.getURL();
            const stateData = lastState[String(screenId)];

            // Si está mostrando fallback y debería mostrar algo remoto
            if (currentUrl.includes('fallback.html') && stateData && stateData.url) {
                log.info(`[RESILIENCE]: Recuperando Pantalla ${screenId} -> ${stateData.url}`);
                
                // Limpiar reintentos pendientes para evitar doble carga
                if (this.context.retryManager && this.context.retryManager.has(screenId)) {
                    const retry = this.context.retryManager.get(screenId);
                    if (retry.timerId) clearTimeout(retry.timerId);
                    this.context.retryManager.delete(screenId);
                }

                // Emitir evento para que main.js ejecute la carga
                this.emit('recover-screen', screenId);
            }
        }
    }
}

module.exports = NetworkMonitor;