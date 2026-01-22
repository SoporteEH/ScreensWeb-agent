jest.useFakeTimers();

const mockLogFile = { path: '/mock/log/dir/main.log' };
const mockLog = {
    transports: {
        file: {
            level: 'info',
            maxSize: 0,
            format: '',
            getFile: jest.fn(() => mockLogFile),
            archiveLogFn: jest.fn()
        },
        console: {
            level: 'debug'
        }
    },
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
};

jest.mock('electron-log', () => mockLog);

// Mock fs
jest.mock('fs', () => ({
    existsSync: jest.fn(),
    readdirSync: jest.fn(),
    statSync: jest.fn(),
    unlinkSync: jest.fn()
}));

const { cleanOldLogs, updaterLog } = require('../../utils/logConfig');
const fs = require('fs');

describe('Log Config Utility', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('cleanOldLogs', () => {
        it('should do nothing if log directory does not exist', () => {
            fs.existsSync.mockReturnValue(false);
            cleanOldLogs();
            expect(fs.readdirSync).not.toHaveBeenCalled();
        });

        it('should delete log files older than 7 days', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readdirSync.mockReturnValue(['old.log', 'new.log', 'other.txt']);

            const now = Date.now();
            const maxAge = 7 * 24 * 60 * 60 * 1000;

            fs.statSync.mockImplementation((path) => {
                if (path.includes('old.log')) {
                    return { mtimeMs: now - maxAge - 1000 };
                }
                return { mtimeMs: now };
            });

            cleanOldLogs();

            expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('old.log'));
            expect(fs.unlinkSync).not.toHaveBeenCalledWith(expect.stringContaining('new.log'));
            expect(fs.unlinkSync).not.toHaveBeenCalledWith(expect.stringContaining('other.txt'));
        });

        it('should handle errors gracefully', () => {
            fs.existsSync.mockImplementation(() => { throw new Error('FS Error'); });
            cleanOldLogs();
            expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('[CLEANUP]'), expect.any(Error));
        });
    });

    describe('updaterLog', () => {
        it('should log update check info only if 10 mins passed', () => {
            const now = Date.now();
            jest.spyOn(Date, 'now').mockReturnValue(now);

            updaterLog.logCheck('1.0.0');
            expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('[UPDATER]: Verificacion periodica'));

            mockLog.info.mockClear();

            updaterLog.logCheck('1.0.0');
            expect(mockLog.info).not.toHaveBeenCalled();

            Date.now.mockReturnValue(now + 11 * 60 * 1000);
            updaterLog.logCheck('1.0.0');
            expect(mockLog.info).toHaveBeenCalled();

            Date.now.mockRestore();
        });

        it('should log update messages', () => {
            updaterLog.logUpdate('Download complete');
            expect(mockLog.info).toHaveBeenCalledWith('[UPDATER]: Download complete');
        });
    });
});
