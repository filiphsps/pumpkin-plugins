import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Standard vitest config for a plugin package (run from the package directory):
 *  - `unit`:        src/**\/*.test.ts, no server needed
 *  - `integration`: test/**\/*.itest.ts, runs against a real Pumpkin (see startPumpkin)
 * Also defines `__PLUGIN_VERSION__` from package.json, like the build does.
 */
export function definePluginVitestConfig() {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    return defineConfig({
        define: { __PLUGIN_VERSION__: JSON.stringify(pkg.version ?? '0.0.0') },
        test: {
            passWithNoTests: true,
            coverage: {
                provider: 'v8',
                include: ['src/**/*.ts'],
                exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
                reporter: ['text', 'lcov']
            },
            projects: [
                { extends: true, test: { name: 'unit', include: ['src/**/*.test.ts'] } },
                {
                    extends: true,
                    test: {
                        name: 'integration',
                        include: ['test/**/*.itest.ts'],
                        testTimeout: 120_000,
                        hookTimeout: 180_000,
                        globalSetup: [fileURLToPath(new URL('./global-setup.ts', import.meta.url))]
                    }
                }
            ]
        }
    });
}
