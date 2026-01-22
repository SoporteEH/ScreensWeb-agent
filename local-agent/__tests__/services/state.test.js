const fs = require('fs').promises;
const path = require('path');

// Mock the Electron module
jest.mock('electron', () => ({
    screen: {
        getAllDisplays: jest.fn(() => [])
    }
}));

// Mock the logger
jest.mock('../../utils/logConfig', () => ({
    log: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn()
    }
}));

// Mock constants with test file path
const mockTestStateFile = require('path').join(__dirname, 'test-state.json');
jest.mock('../../config/constants', () => ({
    STATE_FILE_PATH: require('path').join(__dirname, 'test-state.json')
}));

const { loadLastState, saveCurrentState } = require('../../services/state');

describe('State Service', () => {
    beforeEach(async () => {
        // Clean up test file before each test
        try {
            await fs.unlink(mockTestStateFile);
        } catch (e) { /* ignore if doesn't exist */ }
    });

    afterAll(async () => {
        // Clean up test file after all tests
        try {
            await fs.unlink(mockTestStateFile);
        } catch (e) { /* ignore */ }
    });

    describe('loadLastState', () => {
        it('should return empty object when file does not exist', async () => {
            const result = await loadLastState();
            expect(result).toEqual({});
        });

        it('should handle corrupted JSON gracefully', async () => {
            // Write invalid JSON to test file
            await fs.writeFile(mockTestStateFile, 'invalid json{{{');

            const result = await loadLastState();
            expect(result).toEqual({});
        });

        it('should migrate old string format to object format', async () => {
            const oldFormat = {
                '1': 'https://example.com',
                '2': 'https://test.com'
            };
            await fs.writeFile(mockTestStateFile, JSON.stringify(oldFormat));

            const result = await loadLastState();

            // Check migration happened (credentials removed for security)
            expect(result['1']).toHaveProperty('url', 'https://example.com');
            expect(result['1']).toHaveProperty('timestamp');
            expect(typeof result['1'].timestamp).toBe('string');
            // Credentials are NOT in state anymore
            expect(result['1']).not.toHaveProperty('credentials');
        });

        it('should load valid state correctly', async () => {
            const validState = {
                '1': {
                    url: 'https://example.com',
                    refreshInterval: 0,
                    contentName: 'Test Content',
                    timestamp: new Date().toISOString()
                }
            };
            await fs.writeFile(mockTestStateFile, JSON.stringify(validState));

            const result = await loadLastState();
            expect(result).toEqual(validState);
        });

        it('should handle empty file', async () => {
            await fs.writeFile(mockTestStateFile, '');

            const result = await loadLastState();
            expect(result).toEqual({});
        });
    });

    describe('saveCurrentState', () => {
        it('should create file and save state WITHOUT credentials', async () => {
            const mockTimers = new Map();
            const mockWindows = new Map();

            await saveCurrentState(
                '1',
                'https://example.com',
                null,
                0,
                mockTimers,
                mockWindows,
                'Test Content'
            );

            const saved = await loadLastState();
            expect(saved['1']).toHaveProperty('url', 'https://example.com');
            expect(saved['1']).toHaveProperty('contentName', 'Test Content');
            // Security: credentials should NOT be in state file
            expect(saved['1']).not.toHaveProperty('credentials');
        });

        it('should delete entry when url is null', async () => {
            const mockTimers = new Map();
            const mockWindows = new Map();

            // First save a state
            await saveCurrentState('1', 'https://example.com', null, 0, mockTimers, mockWindows);

            // Then delete it by passing null url
            await saveCurrentState('1', null, null, 0, mockTimers, mockWindows);

            const saved = await loadLastState();
            expect(saved['1']).toBeUndefined();
        });

        it('should merge with existing state', async () => {
            const mockTimers = new Map();
            const mockWindows = new Map();

            // Save screen 1
            await saveCurrentState('1', 'https://screen1.com', null, 0, mockTimers, mockWindows);

            // Save screen 2
            await saveCurrentState('2', 'https://screen2.com', null, 0, mockTimers, mockWindows);

            const saved = await loadLastState();
            expect(Object.keys(saved)).toHaveLength(2);
            expect(saved['1'].url).toBe('https://screen1.com');
            expect(saved['2'].url).toBe('https://screen2.com');
        });
    });
});
