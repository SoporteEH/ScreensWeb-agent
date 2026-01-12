/**
 * Authentication Service
 * Gestiona refresco de token JWT
 */


const { jwtDecode } = require('jwt-decode');
const { log } = require('../utils/logConfig');
const { AGENT_REFRESH_URL } = require('../config/constants');
const { loadConfig, saveConfig } = require('../utils/configManager');

// Refresca token JWT del agente
async function refreshAgentToken(currentAgentToken) {
    log.info('[AGENT-AUTH]: Intentando refrescar el token...');
    try {
        const response = await fetch(AGENT_REFRESH_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${currentAgentToken}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ msg: 'Error de red' }));
            throw new Error(`API error: ${response.status} - ${errorData.msg}`);
        }

        const data = await response.json();
        const config = loadConfig();
        config.agentToken = data.token;
        saveConfig(config);

        log.info('[AGENT-AUTH]: Token refrescado y guardado con exito.');
        return data.token;

    } catch (error) {
        log.error('[AGENT-AUTH]: Fallo al refrescar el token:', error.message);
        return currentAgentToken; // Devuelve el token viejo si falla
    }
}

/**
 * Inicia un bucle periódico para verificar la validez del token y refrescarlo si es necesario.
 * @param {string} agentToken - El token actual
 * @param {Function} onTokenRefreshed - Callback cuando el token se refresca
 * @returns {NodeJS.Timeout} El ID del intervalo
 */
function startTokenRefreshLoop(agentToken, onTokenRefreshed) {
    log.info('[AGENT-AUTH]: Iniciando bucle de verificacion de token (cada 4 horas).');

    const interval = setInterval(async () => {
        try {
            if (!agentToken) return;

            const decoded = jwtDecode(agentToken);
            const expTimeMs = decoded.exp * 1000;
            const nowMs = Date.now();
            const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;


            if ((expTimeMs - nowMs) < THIRTY_DAYS_MS) {
                log.info('[AGENT-AUTH]: El token esta a punto de expirar, iniciando refresco...');
                const newToken = await refreshAgentToken(agentToken);
                if (newToken !== agentToken && onTokenRefreshed) {
                    onTokenRefreshed(newToken);
                }
            }
        } catch (e) {
            log.error('[AGENT-AUTH]: Error en el bucle de verificacion de token:', e);
        }
    }, 4 * 60 * 60 * 1000); // 4 horas

    return interval;
}

module.exports = {
    refreshAgentToken,
    startTokenRefreshLoop
};
