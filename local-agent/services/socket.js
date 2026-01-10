/**
 * Socket Service
 * Gestiona conexión WebSocket y eventos
 */

const { io } = require('socket.io-client');
const { log, heartbeatLog } = require('../utils/logConfig');
const { SERVER_URL, CONSTANTS } = require('../config/constants');

// Establece conexión WebSocket con servidor
function connectToSocketServer(token, handlers) {
    const socket = io(SERVER_URL, {
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 3000,
        reconnectionDelayMax: CONSTANTS.SOCKET_RECONNECT_DELAY_MAX_MS,
        randomizationFactor: 0.5,
        timeout: 20000,
        auth: { token }
    });

    socket.on('connect', () => {
        log.info('[SOCKET]: Conectado al servidor de WebSocket.');
        if (handlers.onConnect) handlers.onConnect();
    });

    socket.on('disconnect', (reason) => {
        log.info(`[SOCKET]: Desconectado del servidor. Razon: ${reason}`);
        if (handlers.onDisconnect) handlers.onDisconnect(reason);

        if (reason === 'io server disconnect') {
            log.info('[SOCKET]: El servidor cerro la conexion. Reconectando manualmente...');
            socket.connect();
        }
    });

    socket.on('reconnect', (attemptNumber) => {
        log.info(`[SOCKET]: Reconectado exitosamente despues de ${attemptNumber} intentos.`);
        if (handlers.onReconnect) handlers.onReconnect(attemptNumber);
    });

    socket.on('reconnect_attempt', (attemptNumber) => {
        log.info(`[SOCKET]: Intento de reconexion #${attemptNumber}...`);
    });

    socket.on('reconnect_error', (error) => {
        log.error(`[SOCKET]: Error en intento de reconexion: ${error.message}`);
    });

    socket.on('connect_error', (error) => {
        log.error(`[SOCKET]: Error de conexion: ${error.message}`);
    });


    socket.on('command', (command) => {
        if (handlers.onCommand) handlers.onCommand(command);
    });

    socket.on('assets-updated', () => {
        if (handlers.onAssetsUpdated) handlers.onAssetsUpdated();
    });

    socket.on('force-reprovision', () => {
        if (handlers.onForceReprovision) handlers.onForceReprovision();
    });

    return socket;
}

// Envía heartbeat al servidor
function sendHeartbeat(socket, screenIds) {
    if (!socket || !socket.connected) return;
    socket.emit('heartbeat', { screenIds });
    heartbeatLog.info(screenIds);
}

module.exports = {
    connectToSocketServer,
    sendHeartbeat
};
