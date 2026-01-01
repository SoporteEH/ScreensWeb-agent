/**
 * Script post-build para limpiar SERVER_URL de package.json
 * 
 * Uso: node scripts/clean-config.js
 */

const fs = require('fs');
const path = require('path');

const packagePath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

// Eliminar config.serverUrl si existe
if (packageJson.config?.serverUrl) {
    delete packageJson.config.serverUrl;

    // Si config queda vacío, eliminarlo también
    if (Object.keys(packageJson.config).length === 0) {
        delete packageJson.config;
    }

    fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
    console.log('✓ config.serverUrl eliminado de package.json');
} else {
    console.log('✓ Nada que limpiar');
}
