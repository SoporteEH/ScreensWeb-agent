/**
 * Tray Service - Gestiona el icono en la bandeja de sistema
 */

const { Tray, Menu, app, BrowserWindow } = require('electron');
const path = require('path');
const log = require('electron-log');

let tray = null;
let controlWindow = null;

/**
 * Inicializa el icono de la bandeja del sistema
 */
function createTray(serverUrl, version) {
    if (tray) return tray;

    try {
        // Usar el icono de la carpeta icons
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
                    log.info('[TRAY]: Saliendo de la aplicación...');
                    app.isQuitting = true;
                    app.quit();
                }
            }
        ]);

        tray.setToolTip('ScreensWeb Agent');
        tray.setContextMenu(contextMenu);

        // Doble click abre el panel de control
        tray.on('double-click', () => {
            openControlWindow(serverUrl, version);
        });

        return tray;
    } catch (error) {
        log.error('[TRAY]: Error al crear el tray icon:', error);
        return null;
    }
}

/**
 * Abre la pequeña ventana de control
 */
function openControlWindow(serverUrl, version) {
    if (controlWindow) {
        controlWindow.focus();
        return;
    }

    controlWindow = new BrowserWindow({
        width: 380,
        height: 500,
        title: 'ScreensWeb Control',
        icon: path.join(__dirname, '..', 'icons', 'icon.png'),
        frame: true,
        resizable: false,
        alwaysOnTop: true,
        titleBarStyle: 'default',
        backgroundColor: '#0a0a0a',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '..', 'preload.js')
        }
    });

    controlWindow.loadFile(path.join(__dirname, '..', 'control.html'));

    // Inyectar datos cuando el DOM esté listo
    controlWindow.webContents.on('did-finish-load', () => {
        controlWindow.webContents.send('agent-info', {
            serverUrl: serverUrl || 'Desconocido',
            version: version || '1.0.0',
            status: 'Online' // Esto se podría actualizar dinámicamente
        });
    });

    controlWindow.on('closed', () => {
        controlWindow = null;
    });

    // Quitar barra de menú
    controlWindow.setMenuBarVisibility(false);
}

module.exports = {
    createTray,
    openControlWindow
};
