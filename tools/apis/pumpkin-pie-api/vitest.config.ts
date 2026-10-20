import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Keep this package's module cache to itself: concurrent runs clear vitest's workspace-wide default.
        fsModuleCachePath: 'node_modules/.vitest-cache',
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
            reporter: ['text', 'lcov'],
        },
        projects: [
            {
                extends: true,
                test: { name: 'unit', include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'scripts/**/*.test.ts'] },
            },
            {
                extends: true,
                test: {
                    name: 'integration',
                    include: ['test/**/*.itest.ts'],
                    globalSetup: ['./test/global-setup.ts'],
                    testTimeout: 120000,
                    hookTimeout: 180000,
                },
            },
        ],
    },
});
