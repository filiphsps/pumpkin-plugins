import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
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
    /** Selected API runtime entry, independent of generated WIT declarations. */
    apiEntry: string;
    /** Injected as `__PLUGIN_VERSION__`. */
    version: string;
    /** Whether this is a development build. */
    developmentMode?: boolean;
}

/**
 * Bundles a plugin with esbuild and turns it into a WebAssembly component, the same two steps and
 * settings `pumpkin-api-ts`'s own build uses, with `pumpkin:plugin/*` and `wasi:*` left as imports.
 * @param options - What to build.
 * @returns The size of the component in bytes.
 */
export async function bundlePlugin(options: BundleOptions): Promise<number> {
    const output = path.resolve(options.output);
    const outputDir = path.dirname(output);
    fs.mkdirSync(outputDir, { recursive: true });
    const temporaryDir = fs.mkdtempSync(path.join(outputDir, '.pumpkin-build-'));
    const bundle = path.join(temporaryDir, 'bundle.js');
    const component = path.join(temporaryDir, 'plugin.wasm');
    let preserveTemporaryDir = false;
    try {
        await esbuild.build({
            entryPoints: [options.entry],
            bundle: true,
            outfile: bundle,
            format: 'esm',
            target: 'es2022',
            external: ['pumpkin:plugin/*', 'wasi:*'],
            alias: { '@pumpkinmc/pumpkin-api-ts': options.apiEntry },
            define: {
                __PLUGIN_VERSION__: JSON.stringify(options.version),
                __PUMPKIN_DEV_MODE__: JSON.stringify(options.developmentMode ?? false)
            }
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
                '--runtime',
                path.join(import.meta.dirname, '../runtime/quickjs-runtime-bigint.wasm'),
                '--output',
                component
            ],
            { stdio: 'inherit' }
        );
        const size = fs.statSync(component).size;
        publishComponent(component, output, temporaryDir, () => {
            preserveTemporaryDir = true;
        });
        return size;
    } finally {
        if (!preserveTemporaryDir) fs.rmSync(temporaryDir, { recursive: true, force: true });
    }
}

function publishComponent(
    component: string,
    output: string,
    temporaryDir: string,
    preserveForRecovery: () => void
): void {
    try {
        fs.renameSync(component, output);
    } catch (error) {
        if (!isReplaceError(error) || !fs.existsSync(output)) throw error;
        const existing = fs.lstatSync(output);
        if (!existing.isFile() && !existing.isSymbolicLink()) throw error;

        const previous = path.join(temporaryDir, 'previous.wasm');
        fs.renameSync(output, previous);
        try {
            fs.renameSync(component, output);
        } catch (publishError) {
            try {
                fs.renameSync(previous, output);
            } catch (restoreError) {
                preserveForRecovery();
                throw new AggregateError(
                    [publishError, restoreError],
                    `could not publish or restore ${output}; previous artifact preserved at ${previous}`
                );
            }
            throw publishError;
        }
    }
}

function isReplaceError(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'EACCES')
    );
}
