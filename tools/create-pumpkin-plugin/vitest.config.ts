import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Keep this package's module cache to itself: concurrent runs clear vitest's workspace-wide default.
        fsModuleCachePath: 'node_modules/.vitest-cache',
        coverage: {
            provider: 'v8',
            include: ['bin/**/*.ts'],
            exclude: ['bin/**/*.test.ts', 'bin/**/*.d.ts'],
            reporter: ['text', 'lcov'],
        },
        projects: [
            { extends: true, test: { name: 'unit', include: ['bin/**/*.test.ts'] } },
            { extends: true, test: { name: 'integration', include: ['test/**/*.itest.ts'] } },
        ],
    },
});
