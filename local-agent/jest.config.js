module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/__tests__/**/*.test.js'],
    coverageDirectory: 'coverage',
    collectCoverageFrom: [
        'services/**/*.js',
        'handlers/**/*.js',
        'utils/**/*.js',
        '!**/__tests__/**',
        '!**/node_modules/**'
    ],
    coverageThreshold: {
        global: {
            statements: 70,
            branches: 60,
            functions: 70,
            lines: 70
        }
    }
};
