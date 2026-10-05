import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);

/** Inputs to `bundlePlugin`. */
export interface BundleOptions {
    /** Source file to bundle. */
    entry: string;
    /** Where to write the `.wasm`. */
    output: string;
    /** The WIT the component is built against. */
    witDir: string;
    /** Injected as `__PLUGIN_VERSION__`. */
    version: string;
}

/**
 * Bundles a plugin with esbuild and turns it into a WebAssembly component, the same two steps and
 * settings `pumpkin-api-ts`'s own build uses, with `pumpkin:plugin/*` and `wasi:*` left as imports.
 * @param options - What to build.
 * @returns The size of the component in bytes.
 */
export async function bundlePlugin(options: BundleOptions): Promise<number> {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    const bundle = path.join(path.dirname(options.output), 'bundle.tmp.js');
    try {
        await esbuild.build({
            entryPoints: [options.entry],
            bundle: true,
            outfile: bundle,
            format: 'esm',
            target: 'es2022',
            external: ['pumpkin:plugin/*', 'wasi:*'],
            define: { __PLUGIN_VERSION__: JSON.stringify(options.version) }
        });
        const componentizerPackage = path.dirname(require.resolve('@di-framework/componentize-qjs/package.json'));
        execFileSync(
            process.execPath,
            [
                path.join(componentizerPackage, 'bin/componentize-qjs.cjs'),
                '--world',
                'plugin',
                '--wit',
                options.witDir,
                '--js',
                bundle,
                '--opt-size',
                '--output',
                options.output
            ],
            { stdio: 'inherit' }
        );
        return fs.statSync(options.output).size;
    } finally {
        fs.rmSync(bundle, { force: true });
    }
}
