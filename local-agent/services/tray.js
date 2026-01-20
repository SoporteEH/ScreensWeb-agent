const { Tray, Menu, app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { log } = require('../utils/logConfig');

let tray = null;
let controlWindow = null;

/**
 * Initialize System Tray with context menu.
 */
function createTray(version) {
    if (tray) return tray;

    try {
        const iconPath = path.join(__dirname, '..', 'icons', 'icon.png');
        tray = new Tray(iconPath);

        const contextMenu = Menu.buildFromTemplate([
            { label: `Screens v${version}`, enabled: false },
            { label: 'Modo: Standalone (Local)', enabled: false },
            { type: 'separator' },
            {
                label: 'Abrir Panel de Control',
                click: () => openControlWindow(version)
            },
            { type: 'separator' },
            {
                label: 'Reiniciar App',
                click: () => {
                    log.info('[TRAY]: Solicitando reinicio...');
                    app.relaunch();
                    app.exit(0);
                }
            },
            { type: 'separator' },
            {
                label: 'Salir',
                click: () => {
                    log.info('[TRAY]: Cerrando aplicacion...');
                    app.isQuitting = true;
                    app.quit();
                }
            }
        ]);

        tray.setToolTip('Screens');
        tray.setContextMenu(contextMenu);

        tray.on('double-click', () => openControlWindow(version));
        return tray;
    } catch (error) {
        log.error('[TRAY]: Error al crear el tray icon:', error);
        return null;
    }
}

/**
 * Window Management: Centralized Control Panel
 */
function openControlWindow(version) {
    if (controlWindow) {
        controlWindow.focus();
        return;
    }

    controlWindow = new BrowserWindow({
        width: 950,
        height: 700,
        title: 'Screens Control',
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
            version: version || '1.0.0',
            status: 'Standalone'
        });
    });

    controlWindow.on('closed', () => {
        controlWindow = null;
    });

    /**
     * RESOURCE THROTTLING (Optimization C)
     * Suspend rendering of the control panel when minimized to save CPU/RAM.
     */
    controlWindow.on('minimize', () => {
        controlWindow.webContents.setBackgroundThrottling(true);
        log.info('[MEMORY]: Panel de Control hibernado (minimizacion).');
    });

    controlWindow.on('restore', () => {
        controlWindow.webContents.setBackgroundThrottling(false);
        log.info('[MEMORY]: Panel de Control restaurado.');
    });

    controlWindow.setMenuBarVisibility(false);

    // Global window actions for the custom frameless titlebar
    ipcMain.on('window-control', (event, action) => {
        if (controlWindow && !controlWindow.isDestroyed()) {
            if (action === 'minimize') controlWindow.minimize();
            else if (action === 'close') controlWindow.close();
        }
    });
}

module.exports = { createTray, openControlWindow };
