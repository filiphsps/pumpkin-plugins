import { defineConfig, type ViteUserConfig } from 'vitest/config';
import { testApiAlias } from '../../scripts/pumpkin-targets.mjs';

export default defineConfig(
    async (): Promise<ViteUserConfig> => ({
        resolve: { alias: await testApiAlias() },
        test: {
            include: ['src/**/*.test.ts'],
            coverage: {
                provider: 'v8',
                include: ['src/**/*.ts'],
                exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
                reporter: ['text', 'lcov']
            }
        }
    })
);
