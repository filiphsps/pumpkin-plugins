import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Builds the standard vitest config for a plugin package; run vitest from the package directory.
 * The `unit` project runs `*.test.ts` files under `src/` without a server. The `integration` project
 * runs `*.itest.ts` files under `test/` against a real Pumpkin server started with `startPumpkin`.
 * Like the build, the config defines `__PLUGIN_VERSION__` from the package's `package.json`.
 *
 * @param options - `unitGlobalSetup` lists Vitest global setup files for the `unit` project, relative
 * to the package directory. They run once before the unit test workers start, so slow preparation
 * such as fetching a pinned input does not count against any test's timeout.
 */
export function definePluginVitestConfig(options: { unitGlobalSetup?: string[] } = {}) {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    return defineConfig({
        define: { __PLUGIN_VERSION__: JSON.stringify(pkg.version ?? '0.0.0') },
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
                    test: { name: 'unit', include: ['src/**/*.test.ts'], globalSetup: options.unitGlobalSetup ?? [] },
                },
                {
                    extends: true,
                    test: {
                        name: 'integration',
                        include: ['test/**/*.itest.ts'],
                        testTimeout: 120_000,
                        hookTimeout: 180_000,
                        globalSetup: [fileURLToPath(new URL('./global-setup.ts', import.meta.url))],
                    },
                },
            ],
        },
    });
}
