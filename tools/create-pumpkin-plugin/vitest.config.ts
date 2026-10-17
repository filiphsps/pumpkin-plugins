import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
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
