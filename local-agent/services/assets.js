/**
 * Servicio de Sincronización de Activos Locales
 * 
 * Descarga y mantiene actualizados los contenidos locales (videos/imagenes).
 */

const fs = require('fs');
const path = require('path');
// Usamos el fetch nativo global de Node/Electron
const { Readable } = require('stream'); // Necesario para manejar streams de descarga con el nuevo fetch
const { log } = require('../utils/logConfig');
const { SYNC_API_URL, CONTENT_DIR, SERVER_URL } = require('../config/constants');

/**
 * Sincroniza activos locales con el servidor.
 * @param {string} agentToken - Token para autenticación
 * @param {boolean} isSyncing - Variable para evitar colisiones (se maneja fuera o se pasa ref)
 * @returns {Promise<boolean>} Nuevo estado de isSyncing
 */
async function syncLocalAssets(agentToken) {
    log.info('[SYNC]: Iniciando proceso de sincronizacion de activos locales...');

    try {
        log.info('[SYNC-DEBUG]: Pidiendo lista de activos desde el servidor...');
        const response = await fetch(SYNC_API_URL, {
            headers: { 'Authorization': `Bearer ${agentToken}` }
        });
        if (!response.ok) {
            throw new Error(`Error del servidor al obtener la lista de activos: ${response.status}`);
        }
        const serverAssets = await response.json();
        log.info(`[SYNC - DEBUG]: El servidor dice que debo tener ${serverAssets.length} archivos.`);

        const serverAssetMap = new Map(serverAssets.map(asset => [asset.serverFilename, asset]));

        if (!fs.existsSync(CONTENT_DIR)) {
            fs.mkdirSync(CONTENT_DIR, { recursive: true });
        }
        const localFiles = fs.readdirSync(CONTENT_DIR);
        log.info(`[SYNC - DEBUG]: Encontrados ${localFiles.length} archivos locales en disco.`);

        // Eliminar obsoletos
        const filesToDelete = localFiles.filter(file => !serverAssetMap.has(file));
        for (const fileToDelete of filesToDelete) {
            try {
                fs.unlinkSync(path.join(CONTENT_DIR, fileToDelete));
                log.info(`[SYNC]: Archivo obsoleto eliminado: ${fileToDelete}`);
            } catch (err) {
                log.error(`[SYNC]: Error al eliminar el archivo ${fileToDelete}: `, err);
            }
        }

        // Descargar nuevos
        const filesToDownload = serverAssets.filter(asset => !localFiles.includes(asset.serverFilename));
        for (const assetToDownload of filesToDownload) {
            log.info(`[SYNC]: Descargando nuevo activo: ${assetToDownload.originalFilename}...`);
            const downloadUrl = `${SERVER_URL}/local-assets/${assetToDownload.serverFilename}`;
            const destinationPath = path.join(CONTENT_DIR, assetToDownload.serverFilename);

            try {
                const downloadResponse = await fetch(downloadUrl);
                if (!downloadResponse.ok) throw new Error(`Fallo la descarga: ${downloadResponse.statusText}`);

                const fileStream = fs.createWriteStream(destinationPath);
                await new Promise((resolve, reject) => {
                    Readable.fromWeb(downloadResponse.body).pipe(fileStream);
                    fileStream.on('finish', resolve);
                    fileStream.on('error', reject);
                });
                log.info(`[SYNC]: Descarga completa: ${assetToDownload.originalFilename}`);
            } catch (err) {
                log.error(`[SYNC]: Error al descargar ${assetToDownload.originalFilename}: `, err);
                if (fs.existsSync(destinationPath)) {
                    fs.unlinkSync(destinationPath);
                }
            }
        }

        log.info('[SYNC]: Proceso de sincronizacion finalizado.');
        return true;

    } catch (error) {
        log.error('[SYNC]: Error critico durante la sincronizacion:', error.message);
        return false;
    }
}

module.exports = {
    syncLocalAssets
};
