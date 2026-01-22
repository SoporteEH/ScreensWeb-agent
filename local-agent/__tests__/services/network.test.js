const NetworkMonitor = require('../../services/network');

// Mock Electron
jest.mock('electron', () => ({
    net: {
        isOnline: jest.fn(() => true)
    }
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
    loadLastState: jest.fn(() => ({}))
}));

describe('Network Monitor', () => {
    let mockContext;
    let monitor;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();

        mockContext = {
            managedWindows: new Map(),
            retryManager: new Map()
        };

        monitor = new NetworkMonitor(mockContext);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('should start with online status', () => {
        expect(monitor.isOnline).toBe(true);
    });

    it('should start polling on start()', () => {
        const { net } = require('electron');
        net.isOnline.mockReturnValue(true);
        const setIntervalSpy = jest.spyOn(global, 'setInterval');

        monitor.start(5000);

        expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
        expect(net.isOnline).toHaveBeenCalled();
        setIntervalSpy.mockRestore();
    });

    it('should detect network-offline transition', async () => {
        const { net } = require('electron');
        const offlineSpy = jest.fn();
        monitor.on('network-offline', offlineSpy);

        monitor.isOnline = true;
        net.isOnline.mockReturnValue(false);

        await monitor.check();

        expect(monitor.isOnline).toBe(false);
        expect(offlineSpy).toHaveBeenCalled();
    });

    it('should detect network-online transition', async () => {
        const { net } = require('electron');
        const onlineSpy = jest.fn();
        monitor.on('network-online', onlineSpy);

        monitor.isOnline = false;
        net.isOnline.mockReturnValue(true);

        await monitor.check();

        expect(monitor.isOnline).toBe(true);
        expect(onlineSpy).toHaveBeenCalled();
    });

    it('should trigger fallback for remote URLs when offline', async () => {
        const { net } = require('electron');
        const { loadLastState } = require('../../services/state');

        const mockWin = {
            isDestroyed: jest.fn(() => false),
            webContents: {
                getURL: jest.fn(() => 'https://remote.com')
            },
            loadURL: jest.fn()
        };
        mockContext.managedWindows.set('1', mockWin);

        loadLastState.mockReturnValue({
            '1': { url: 'https://remote.com' }
        });

        monitor.isOnline = true;
        net.isOnline.mockReturnValue(false);

        await monitor.check();

        expect(mockWin.loadURL).toHaveBeenCalledWith(expect.stringContaining('fallback.html'));
    });

    it('should NOT trigger fallback for local URLs when offline', async () => {
        const { net } = require('electron');
        const { loadLastState } = require('../../services/state');

        const mockWin = {
            isDestroyed: jest.fn(() => false),
            webContents: {
                getURL: jest.fn(() => 'file:///content/index.html')
            },
            loadURL: jest.fn()
        };
        mockContext.managedWindows.set('1', mockWin);

        loadLastState.mockReturnValue({
            '1': { url: 'local:index.html' }
        });

        monitor.isOnline = true;
        net.isOnline.mockReturnValue(false);

        await monitor.check();

        expect(mockWin.loadURL).not.toHaveBeenCalled();
    });
});
