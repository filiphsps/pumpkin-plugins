import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Keep this package's module cache to itself: concurrent runs clear vitest's workspace-wide default.
        fsModuleCachePath: 'node_modules/.vitest-cache',
        include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
            reporter: ['text', 'lcov'],
        },
    },
});
