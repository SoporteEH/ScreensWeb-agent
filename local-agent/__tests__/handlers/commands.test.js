const { handleShowUrl, initializeHandlers, sendCommandFeedback } = require('../../handlers/commands');
const { log } = require('../../utils/logConfig');

// Mock Electron
jest.mock('electron', () => {
    const mBrowserWindow = jest.fn(() => ({
        loadURL: jest.fn().mockResolvedValue(true),
        on: jest.fn(),
        once: jest.fn(),
        show: jest.fn(),
        close: jest.fn(),
        isDestroyed: jest.fn(() => false),
        webContents: {
            on: jest.fn(),
            once: jest.fn(),
            isLoading: jest.fn(() => false),
            stop: jest.fn(),
            getURL: jest.fn(() => 'https://example.com'),
            executeJavaScript: jest.fn().mockResolvedValue(true),
            removeAllListeners: jest.fn()
        }
    }));

    return {
        BrowserWindow: mBrowserWindow,
        app: {
            getAppPath: jest.fn(() => '/mock/app/path'),
            getPath: jest.fn(() => '/mock/user/data')
        },
        net: {
            isOnline: jest.fn(() => true)
        }
    };
});

// Mock constants
jest.mock('../../config/constants', () => ({
    CONTENT_DIR: '/mock/content/dir',
    CREDENTIALS_FILE_PATH: '/mock/credentials.json'
}));

// Mock Logger
jest.mock('../../utils/logConfig', () => ({
    log: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn()
    }
}));

// Mock State Service
jest.mock('../../services/state', () => ({
    loadLastState: jest.fn(() => Promise.resolve({})),
    saveCurrentState: jest.fn(() => Promise.resolve())
}));

// Mock Encryption Service
jest.mock('../../utils/encryption', () => ({
    decrypt: jest.fn((data) => 'decrypted_value'),
    encrypt: jest.fn((text) => ({ encrypted: '...', iv: '...', authTag: '...' }))
}));

// Mock fs.promises
jest.mock('fs', () => ({
    promises: {
        readFile: jest.fn(),
        access: jest.fn().mockResolvedValue(true),
        mkdir: jest.fn().mockResolvedValue(true),
        writeFile: jest.fn().mockResolvedValue(true)
    }
}));

describe('Commands Handler', () => {
    let mockContext;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();

        mockContext = {
            managedWindows: new Map(),
            retryManager: new Map(),
            autoRefreshTimers: new Map(),
            identifyWindows: new Map(),
            hardwareIdToDisplayMap: new Map([
                ['1', { bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]
            ]),
            saveCurrentState: require('../../services/state').saveCurrentState
        };

        initializeHandlers(mockContext);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('handleShowUrl', () => {
        it('should create a window and load URL on valid screen', async () => {
            const command = {
                screenIndex: '1',
                url: 'https://test.com',
                contentName: 'Test'
            };

            const promise = handleShowUrl(command);
            jest.runAllTimers();
            await promise;

            const { BrowserWindow } = require('electron');
            expect(BrowserWindow).toHaveBeenCalled();
            expect(mockContext.managedWindows.has('1')).toBe(true);
        });

        it('should handle local URLs correctly', async () => {
            const command = {
                screenIndex: '1',
                url: 'local:index.html',
                contentName: 'Local'
            };

            const promise = handleShowUrl(command);
            jest.runAllTimers();
            await promise;

            const win = mockContext.managedWindows.get('1');
            expect(win.loadURL).toHaveBeenCalledWith(expect.stringContaining('index.html'));
            // Use regex to be more flexible with path separators on different OSs
            expect(win.loadURL).toHaveBeenCalledWith(expect.stringMatching(/file:\/\/.*index\.html/));
        });

        it('should fail gracefully if screen not found', async () => {
            const command = {
                screenIndex: '99',
                url: 'https://test.com',
                commandId: 'cmd123'
            };

            const promise = handleShowUrl(command);
            jest.runAllTimers();
            await promise;

            expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('[WINDOW]: Creando ventana'));
            expect(mockContext.managedWindows.size).toBe(0);
        });

        it('should load credentials from secrets.json for autologin sites if not provided', async () => {
            const fs = require('fs').promises;
            fs.readFile.mockResolvedValue(JSON.stringify({
                'luckia_user': { encrypted: '...', iv: '...', authTag: '...' },
                'luckia_pass': { encrypted: '...', iv: '...', authTag: '...' }
            }));

            const command = {
                screenIndex: '1',
                url: 'https://luckia.tv',
                contentName: 'Luckia'
            };

            const promise = handleShowUrl(command);
            jest.runAllTimers();
            await promise;

            // Should have read file
            expect(fs.readFile).toHaveBeenCalled();

            // Should have tried to inject (did-finish-load listener attached)
            const win = mockContext.managedWindows.get('1');
            expect(win.webContents.once).toHaveBeenCalledWith('did-finish-load', expect.any(Function));
        });
    });

    describe('sendCommandFeedback', () => {
        it('should log info if not silent', () => {
            const command = { commandId: 'test1', silent: false };
            sendCommandFeedback(command, 'success', 'OK');
            expect(log.info).toHaveBeenCalledWith(expect.stringContaining('[Status:success] OK'));
        });

        it('should NOT log if silent', () => {
            const command = { commandId: 'test1', silent: true };
            sendCommandFeedback(command, 'success', 'OK');
            expect(log.info).not.toHaveBeenCalled();
        });
    });
});
