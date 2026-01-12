/**
 * Script pre-build inyecta SERVER_URL en package.json
 * 
 * Lee SERVER_URL del entorno y lo inyecta en package.json
 * antes del build de electron-builder.
 */

const fs = require('fs');
const path = require('path');

const SERVER_URL = process.env.SERVER_URL;

if (!SERVER_URL) {
    console.error('ERROR: SERVER_URL environment variable is required');
    console.error('Usage: SERVER_URL=http://your-server.com node scripts/inject-config.js');
    process.exit(1);
}

const packagePath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

// Inyecta la configuración
packageJson.config = packageJson.config || {};
packageJson.config.serverUrl = SERVER_URL;

fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');

console.log(`✓ SERVER_URL inyectado: ${SERVER_URL}`);
console.log(`✓ package.json actualizado`);
