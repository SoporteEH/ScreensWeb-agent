const { app } = require('electron');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

/**
 * Defined in UserData to persist through updates and reboots.
 */
const CONFIG_DIR = path.join(app.getPath('userData'), 'ScreensWeb');
const STATE_FILE_PATH = path.join(CONFIG_DIR, 'state.json');
const CREDENTIALS_FILE_PATH = path.join(CONFIG_DIR, 'secrets.json');
const SETTINGS_FILE_PATH = path.join(CONFIG_DIR, 'settings.json');
const CONTENT_DIR = path.join(CONFIG_DIR, 'content');
const ADBLOCK_CACHE_PATH = path.join(CONFIG_DIR, 'adblocker.bin');

/**
 * APP THRESHOLDS & INTERVALS
 */
const CONSTANTS = {
    SCREEN_DEBOUNCE_MS: 500,
    GC_INTERVAL_MS: 4 * 60 * 60 * 1000,
    NETWORK_CHECK_INTERVAL_MS: 10 * 1000,
};

// Application version from package.json
let AGENT_VERSION = require('../package.json').version;

module.exports = {
    CONFIG_DIR,
    STATE_FILE_PATH,
    CONTENT_DIR,
    CONSTANTS,
    CREDENTIALS_FILE_PATH,
    SETTINGS_FILE_PATH,
    ADBLOCK_CACHE_PATH,
    AGENT_VERSION
};
