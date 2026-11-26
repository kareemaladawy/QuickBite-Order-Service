module.exports = {
    transform: {
        '^.+\\.(t|j)s$': [
            '@swc/jest',
            {
                jsc: {
                    parser: {syntax: 'typescript', decorators: true},
                    transform: {
                        legacyDecorator: true,
                        decoratorMetadata: true,
                    },
                    target: 'es2022',
                },
                module: {type: 'commonjs'},
            },
        ],
    },
    transformIgnorePatterns: ['/node_modules/(?!uuid/)'],
    testEnvironment: 'node',
    moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
    roots: ['<rootDir>/tests/integration'],
    testMatch: ['**/*.integration.test.ts'],
    setupFiles: ['<rootDir>/tests/setup-env.ts'],
    globalSetup: '<rootDir>/tests/integration/globalSetup.ts',
    globalTeardown: '<rootDir>/tests/integration/teardown.ts',
    maxWorkers: 1, // regions share hot/archive DBs across test files; keep runs serialized
    forceExit: true,
};
