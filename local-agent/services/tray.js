/**
 * Tray Service - Gestiona el icono en la bandeja de sistema
 */

const { Tray, Menu, app, BrowserWindow } = require('electron');
const path = require('path');
const { log } = require('../utils/logConfig');

let tray = null;
let controlWindow = null;

const { getDeviceName } = require('./identity');

// Inicializa icono de bandeja
function createTray(serverUrl, version) {
    if (tray) return tray;

    try {

        const iconPath = path.join(__dirname, '..', 'icons', 'icon.png');
        tray = new Tray(iconPath);

        const contextMenu = Menu.buildFromTemplate([
            { label: `ScreensWeb Agent v${version}`, enabled: false },
            { label: 'Servidor: ' + (serverUrl || 'No configurado'), enabled: false },
            { type: 'separator' },
            {
                label: 'Abrir Panel de Control',
                click: () => openControlWindow(serverUrl, version)
            },
            { type: 'separator' },
            {
                label: 'Reiniciar Agente',
                click: () => {
                    log.info('[TRAY]: Reiniciando agente...');
                    app.relaunch();
                    app.exit(0);
                }
            },
            {
                label: 'Buscar Actualización',
                click: () => {
                    const { handleForceUpdate } = require('./updater');
                    handleForceUpdate();
                }
            },
            { type: 'separator' },
            {
                label: 'Salir',
                click: () => {
                    log.info('[TRAY]: Saliendo de la aplicacion...');
                    app.isQuitting = true;
                    app.quit();
                }
            }
        ]);

        tray.setToolTip('ScreensWeb Agent');
        tray.setContextMenu(contextMenu);


        tray.on('double-click', () => {
            openControlWindow(serverUrl, version);
        });

        return tray;
    } catch (error) {
        log.error('[TRAY]: Error al crear el tray icon:', error);
        return null;
    }
}

// Abre ventana de control
function openControlWindow(serverUrl, version) {
    if (controlWindow) {
        controlWindow.focus();
        return;
    }

    const deviceName = getDeviceName();

    controlWindow = new BrowserWindow({
        width: 420,
        height: 600,
        title: 'ScreensWeb Control',
        icon: path.join(__dirname, '..', 'icons', 'icon.png'),
        frame: false,
        resizable: false,
        alwaysOnTop: true,
        backgroundColor: '#1a1a1a',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '..', 'preload.js')
        }
    });

    controlWindow.loadFile(path.join(__dirname, '..', 'control.html'));


    controlWindow.webContents.on('did-finish-load', () => {
        controlWindow.webContents.send('agent-info', {
            serverUrl: serverUrl || 'Desconocido',
            version: version || '1.0.0',
            status: 'Online',
            deviceName: deviceName
        });
    });

    controlWindow.on('closed', () => {
        controlWindow = null;
    });


    controlWindow.setMenuBarVisibility(false);


    const { ipcMain } = require('electron');
    ipcMain.removeAllListeners('window-control');
    ipcMain.on('window-control', (event, action) => {
        if (controlWindow && !controlWindow.isDestroyed()) {
            if (action === 'minimize') {
                controlWindow.minimize();
            } else if (action === 'close') {
                controlWindow.close();
            }
        }
    });
}

module.exports = {
    createTray,
    openControlWindow
};
