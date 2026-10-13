import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        projects: [
            {
                extends: true,
                test: {
                    name: 'unit',
                    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
                    exclude: ['test/upstream/**/*.test.ts']
                }
            },
            {
                extends: true,
                test: {
                    name: 'upstream',
                    include: ['test/upstream/**/*.test.ts'],
                    testTimeout: 120_000
                }
            },
            {
                extends: true,
                test: {
                    name: 'integration',
                    include: ['test/**/*.itest.ts'],
                    testTimeout: 120_000,
                    hookTimeout: 180_000,
                    globalSetup: [fileURLToPath(new URL('../test-harness/src/global-setup.ts', import.meta.url))]
                }
            }
        ]
    }
});
