import * as fs from 'node:fs';
import * as path from 'node:path';
import { componentize } from 'componentize-qjs';
import * as esbuild from 'esbuild';

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
        const { component } = await componentize({
            world: 'plugin',
            witPath: options.witDir,
            jsSource: fs.readFileSync(bundle, 'utf8'),
            optSize: true
        });
        fs.writeFileSync(options.output, component);
        return component.length;
    } finally {
        fs.rmSync(bundle, { force: true });
    }
}
