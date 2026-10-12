import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { buildStaticHermesComponent, staticHermesImportsPlugin } from '@pumpkin-plugins/static-hermes-runtime';
import * as esbuild from 'esbuild';
import type { PluginEngine, StaticHermesRuntime } from './plugin-config.ts';
import { generateTypes } from './types.ts';
import { findUsedWitMethods } from './wit-method-usage.ts';

const require = createRequire(import.meta.url);
const MAX_PRODUCTION_COMPONENT_BYTES = 5 * 1024 * 1024;
const TEMPORARY_DIRECTORY_PREFIX = '.pumpkin-build-';
const LEGACY_TEMPORARY_DIRECTORY_MAX_AGE_MS = 60 * 60 * 1000;
const activeTemporaryDirectories = new Set<string>();

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
    /** Runtime used for the component. Defaults to Static Hermes. */
    engine?: PluginEngine;
    /** Static Hermes VM profile. Defaults to lean, which omits runtime `eval`. */
    staticHermesRuntime?: StaticHermesRuntime;
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
    removeAbandonedTemporaryDirectories(outputDir);
    const temporaryDir = fs.mkdtempSync(path.join(outputDir, `${TEMPORARY_DIRECTORY_PREFIX}${process.pid}-`));
    activeTemporaryDirectories.add(temporaryDir);
    const bundle = path.join(temporaryDir, 'bundle.js');
    const component = path.join(temporaryDir, 'plugin.wasm');
    const engine = options.engine ?? 'static-hermes';
    const resolvedWasiImports = new Set<string>();
    let preserveTemporaryDir = false;
    try {
        await esbuild.build({
            entryPoints: [options.entry],
            bundle: true,
            outfile: bundle,
            format: engine === 'quickjs' ? 'esm' : 'iife',
            ...(engine === 'static-hermes'
                ? {
                      globalName: '__pumpkinPlugin',
                      plugins: [
                          staticHermesImportsPlugin({
                              resolveDir: path.dirname(path.resolve(options.entry)),
                              witDir: options.witDir,
                              developmentMode: options.developmentMode ?? false,
                              onWasiImport: (specifier) => resolvedWasiImports.add(specifier)
                          })
                      ]
                  }
                : {}),
            target: 'es2022',
            minify: !options.developmentMode,
            treeShaking: true,
            external: ['pumpkin:plugin/*', 'wasi:*'],
            define: {
                __PLUGIN_VERSION__: JSON.stringify(options.version),
                __PUMPKIN_DEV_MODE__: JSON.stringify(options.developmentMode ?? false),
                'process.env.NODE_ENV': JSON.stringify(options.developmentMode ? 'development' : 'production')
            }
        });
        if (engine === 'static-hermes') {
            const source = fs.readFileSync(bundle, 'utf8');
            const unsupportedWasiImports = staticHermesWasiImports(source).filter(
                (specifier) => !resolvedWasiImports.has(specifier)
            );
            if (unsupportedWasiImports.length > 0) {
                throw new Error(
                    `Static Hermes JavaScript bundle imports WASI interface${unsupportedWasiImports.length === 1 ? '' : 's'} without a JSI adapter: ${unsupportedWasiImports.join(', ')}`
                );
            }
            fs.writeFileSync(bundle, unwrapStaticHermesExports(source));
            const generatedTypes = path.join(temporaryDir, 'wit-types');
            generateTypes(options.witDir, generatedTypes);
            const usedWitMethods = findUsedWitMethods(options.entry, generatedTypes);
            buildStaticHermesComponent({
                bundle,
                witDir: options.witDir,
                output: component,
                developmentMode: options.developmentMode ?? false,
                wasiImports: [...resolvedWasiImports],
                ...(options.staticHermesRuntime === undefined ? {} : { runtimeVariant: options.staticHermesRuntime }),
                ...(usedWitMethods === undefined
                    ? {}
                    : {
                          apiMethods: usedWitMethods.pumpkinMethods,
                          wasiMethods: usedWitMethods.wasiMethods
                      })
            });
        } else {
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
        }
        const size = fs.statSync(component).size;
        if (!options.developmentMode && size > MAX_PRODUCTION_COMPONENT_BYTES) {
            throw new Error(
                `Production WebAssembly component is ${size} bytes; maximum is ${MAX_PRODUCTION_COMPONENT_BYTES} bytes (5 MiB)`
            );
        }
        publishComponent(component, output, temporaryDir, () => {
            preserveTemporaryDir = true;
        });
        return size;
    } finally {
        activeTemporaryDirectories.delete(temporaryDir);
        if (!preserveTemporaryDir) fs.rmSync(temporaryDir, { recursive: true, force: true });
    }
}

function removeAbandonedTemporaryDirectories(outputDir: string): void {
    for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith(TEMPORARY_DIRECTORY_PREFIX)) continue;
        const temporaryDir = path.join(outputDir, entry.name);
        if (activeTemporaryDirectories.has(temporaryDir) || fs.existsSync(path.join(temporaryDir, 'previous.wasm'))) {
            continue;
        }

        const owner = /^\.pumpkin-build-(\d+)-/.exec(entry.name);
        if (owner) {
            const pid = Number(owner[1]);
            if (pid !== process.pid && isProcessRunning(pid)) continue;
            fs.rmSync(temporaryDir, { recursive: true, force: true });
            continue;
        }

        if (Date.now() - fs.statSync(temporaryDir).mtimeMs >= LEGACY_TEMPORARY_DIRECTORY_MAX_AGE_MS) {
            fs.rmSync(temporaryDir, { recursive: true, force: true });
        }
    }
}

function isProcessRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM';
    }
}

function staticHermesWasiImports(source: string): string[] {
    return [...new Set([...source.matchAll(/["'](wasi:[^"']+)["']/g)].map((match) => match[1] as string))];
}

function unwrapStaticHermesExports(source: string): string {
    const matches = [...source.matchAll(/return\s+[$\w]+\(([$\w]+)\);(\s*}\)\(\);)/g)];
    const match = matches.at(-1);
    if (!match?.index) throw new Error('Static Hermes bundle has an unsupported esbuild IIFE export wrapper');
    const end = match.index + match[0].length;
    const suffix = source.slice(end);
    if (!isTrailingLicenseComment(suffix)) {
        throw new Error('Static Hermes bundle has unsupported code after its esbuild IIFE export wrapper');
    }
    return `${source.slice(0, match.index)}return ${match[1]};${match[2]}${suffix}`;
}

function isTrailingLicenseComment(source: string): boolean {
    let remaining = source.trim();
    while (remaining) {
        if (!remaining.startsWith('/*!')) return false;
        const end = remaining.indexOf('*/', 3);
        if (end < 0) return false;
        remaining = remaining.slice(end + 2).trim();
    }
    return true;
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
