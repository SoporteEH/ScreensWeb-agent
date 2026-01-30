const { ipcMain, app } = require('electron');
const { log } = require('../utils/logConfig');
const { openControlWindow } = require('../services/tray');
const { handleForceUpdate } = require('../services/updater');

const registerIpcHandlers = (getServerUrl, AGENT_VERSION) => {
    ipcMain.on('agent-action', (event, { action, data }) => {
        log.info(`[IPC]: Recibida accion: ${action}`);

        switch (action) {
            case 'restart':
            case 'restart-agent':
                log.info('[IPC]: Reiniciando agente...');
                app.relaunch();
                app.exit(0);
                break;
            case 'check-update':
                log.info('[IPC]: Forzando busqueda de actualizacion...');
                handleForceUpdate();
                break;
            case 'quit':
            case 'quit-agent':
                log.info('[IPC]: Cerrando agente...');
                app.isQuitting = true;
                app.quit();
                break;
            case 'open-control':
                openControlWindow(getServerUrl(), AGENT_VERSION);
                break;
        }
    });

    ipcMain.handle('get-app-version', () => {
        return AGENT_VERSION;
    });
};

module.exports = { registerIpcHandlers };
