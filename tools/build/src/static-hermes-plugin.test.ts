import * as path from 'node:path';
import { staticHermesImportsPlugin } from '@pumpkin-plugins/static-hermes-runtime';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';

describe('Static Hermes esbuild plugin', () => {
    it.each([true, false])('keeps developmentMode=%s bundles free of WASI HTTP imports', async (developmentMode) => {
        const result = await esbuild.build({
            stdin: {
                contents:
                    "import { registerPluginWithUpdates } from '@pumpkin-plugins/update-check'; registerPluginWithUpdates({});",
                resolveDir: path.resolve(import.meta.dirname, '../../../packages/apple-skin-pumpkin/src'),
                sourcefile: 'plugin.ts'
            },
            bundle: true,
            format: 'iife',
            write: false,
            minify: false,
            plugins: [
                staticHermesImportsPlugin({
                    resolveDir: path.resolve(import.meta.dirname, '../../../packages/apple-skin-pumpkin/src')
                })
            ],
            external: ['pumpkin:plugin/*', 'wasi:*'],
            define: { __PUMPKIN_DEV_MODE__: JSON.stringify(developmentMode) }
        });

        expect(result.outputFiles[0]?.text).toContain('registerPlugin(');
        expect(result.outputFiles[0]?.text).not.toContain('wasi:http');
        expect(result.outputFiles[0]?.text).not.toContain('wasi:clocks');
    });
});
