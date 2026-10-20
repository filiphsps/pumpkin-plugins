import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { EXTERNAL_MODULES } from '@pumpkin-plugins/wasi-capabilities';
import * as esbuild from 'esbuild';
import { BuildError, runtimeBuildError } from './errors.ts';
import type { BuildOutputMessage } from './output.ts';
import type { PluginEngine, StaticHermesGc, StaticHermesRuntime } from './plugin-config.ts';
import { replaceOutput } from './replace-output.ts';
import { generateTypes } from './types.ts';

const require = createRequire(import.meta.url);
const MAX_PRODUCTION_COMPONENT_BYTES = 5 * 1024 * 1024;
const TEMPORARY_DIRECTORY_PREFIX = '.pumpkin-build-';
const LEGACY_TEMPORARY_DIRECTORY_MAX_AGE_MS = 60 * 60 * 1000;
const activeTemporaryDirectories = new Set<string>();
const WASI_CAPABILITY_HINT = 'Declare the WASI capability the plugin needs in "pumpkinPlugin.wasi".';

/** Inputs to `bundlePlugin`. */
export interface BundleOptions {
    /** Whether this is a development build. */
    developmentMode?: boolean;
    /** Runtime used for the component. */
    engine: PluginEngine;
    /** Source file to bundle. */
    entry: string;
    /** Receives build messages for formatting by the build command. */
    onOutput?: (message: BuildOutputMessage) => void;
    /** Where to write the `.wasm`. */
    output: string;
    /** Pass the bundle to Hermes's partial, unstable TypeScript parser. Static Hermes only. */
    parseTypeScript?: boolean;
    /** Consumer project root used for runtime toolchain caches. */
    projectRoot?: string;
    /** Suppress runtime stdout while preserving stderr for the build command's shared formatter. */
    quietRuntimeOutput?: boolean;
    /** Static Hermes garbage collector. Defaults to Hades. */
    staticHermesGc?: StaticHermesGc;
    /** Static Hermes VM profile. Defaults to lean, which omits runtime `eval`. */
    staticHermesRuntime?: StaticHermesRuntime;
    /** Injected as `__PLUGIN_VERSION__`. */
    version: string;
    /** The WIT the component is built against. */
    witDir: string;
}

/**
 * Bundles a plugin with esbuild and turns it into a WebAssembly component, leaving
 * `pumpkin:plugin/*` and `wasi:*` as imports.
 * Oversized production builds warn, or fail when `PUMPKIN_PLUGINS_FAIL_ON_SIZE_LIMIT=1` is set.
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
    const engine = options.engine;
    const quietRuntimeOutput = options.quietRuntimeOutput ?? false;
    const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
    const resolvedWasiImports = new Set<string>();
    let preserveTemporaryDir = false;
    // Load the Static Hermes runtime and the TypeScript compiler only for builds that use them.
    const staticHermes =
        engine === 'static-hermes' ? await import('@pumpkin-plugins/static-hermes-runtime') : undefined;
    try {
        let buildResult: esbuild.BuildResult;
        try {
            buildResult = await esbuild.build({
                entryPoints: [options.entry],
                bundle: true,
                outfile: bundle,
                metafile: engine === 'static-hermes',
                format: engine === 'quickjs' ? 'esm' : 'iife',
                ...(staticHermes
                    ? {
                          globalName: '__pumpkinPlugin',
                          plugins: [
                              staticHermes.staticHermesImportsPlugin({
                                  resolveDir: path.dirname(path.resolve(options.entry)),
                                  workspaceRoot: projectRoot,
                                  witDir: options.witDir,
                                  developmentMode: options.developmentMode ?? false,
                                  onWasiImport: (specifier) => resolvedWasiImports.add(specifier),
                              }),
                          ],
                      }
                    : {}),
                target: 'es2022',
                minify: !options.developmentMode,
                treeShaking: true,
                external: [...EXTERNAL_MODULES],
                define: {
                    __PLUGIN_VERSION__: JSON.stringify(options.version),
                    __PUMPKIN_DEV_MODE__: JSON.stringify(options.developmentMode ?? false),
                    'process.env.NODE_ENV': JSON.stringify(options.developmentMode ? 'development' : 'production'),
                },
            });
        } catch (error) {
            throw bundleError(error, options.entry);
        }
        if (staticHermes) {
            const { findUsedWitMethods } = await import('./wit-method-usage.ts');
            const source = fs.readFileSync(bundle, 'utf8');
            const unsupportedWasiImports = staticHermesWasiImports(buildResult.metafile).filter(
                (specifier) => !resolvedWasiImports.has(specifier),
            );
            if (unsupportedWasiImports.length > 0) {
                throw new BuildError(
                    `Static Hermes JavaScript bundle imports WASI interface${unsupportedWasiImports.length === 1 ? '' : 's'} without a JSI adapter: ${unsupportedWasiImports.join(', ')}. ${WASI_CAPABILITY_HINT}`,
                );
            }
            fs.writeFileSync(bundle, unwrapStaticHermesExports(source));
            const generatedTypes = path.join(temporaryDir, 'wit-types');
            generateTypes(options.witDir, generatedTypes);
            const usedWitMethods = buildResult.metafile
                ? findUsedWitMethods({
                      entry: options.entry,
                      inputs: bundledFiles(buildResult.metafile),
                      typesDir: generatedTypes,
                      witDir: options.witDir,
                  })
                : undefined;
            options.onOutput?.({
                type: 'componentize',
                engine,
                ...(options.staticHermesRuntime === undefined ? {} : { runtimeVariant: options.staticHermesRuntime }),
                ...(options.staticHermesGc === undefined ? {} : { gcVariant: options.staticHermesGc }),
                ...(options.parseTypeScript ? { parseTypeScript: true } : {}),
                ...(!quietRuntimeOutput
                    ? {
                          selections: {
                              wasiImports: [...resolvedWasiImports],
                              ...(usedWitMethods === undefined
                                  ? {}
                                  : {
                                        wasiMethods: usedWitMethods.wasiMethods,
                                        apiMethods: usedWitMethods.pumpkinMethods,
                                        ...(usedWitMethods.eventTypes === undefined
                                            ? {}
                                            : { eventTypes: usedWitMethods.eventTypes }),
                                    }),
                          },
                      }
                    : {}),
            });
            try {
                staticHermes.buildStaticHermesComponent({
                    bundle,
                    witDir: options.witDir,
                    output: component,
                    workspaceRoot: projectRoot,
                    developmentMode: options.developmentMode ?? false,
                    wasiImports: [...resolvedWasiImports],
                    ...(quietRuntimeOutput ? { quietOutput: true } : {}),
                    ...(options.staticHermesRuntime === undefined
                        ? {}
                        : { runtimeVariant: options.staticHermesRuntime }),
                    ...(options.staticHermesGc === undefined ? {} : { gcVariant: options.staticHermesGc }),
                    ...(options.parseTypeScript ? { parseTypeScript: true } : {}),
                    ...(usedWitMethods === undefined
                        ? {}
                        : {
                              apiMethods: usedWitMethods.pumpkinMethods,
                              wasiMethods: usedWitMethods.wasiMethods,
                              ...(usedWitMethods.eventTypes === undefined
                                  ? {}
                                  : { eventTypes: usedWitMethods.eventTypes }),
                          }),
                });
            } catch (error) {
                throw runtimeBuildError('Static Hermes', error);
            }
        } else {
            const componentizerPackage = path.dirname(require.resolve('@di-framework/componentize-qjs/package.json'));
            options.onOutput?.({ type: 'componentize', engine });
            try {
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
                        component,
                    ],
                    {
                        stdio: quietRuntimeOutput ? ['inherit', 'ignore', 'pipe'] : 'inherit',
                        ...(quietRuntimeOutput ? { maxBuffer: 16 * 1024 * 1024 } : {}),
                    },
                );
            } catch (error) {
                throw runtimeBuildError('QuickJS', error);
            }
        }
        const size = fs.statSync(component).size;
        if (!options.developmentMode && size > MAX_PRODUCTION_COMPONENT_BYTES) {
            const message = `Production WebAssembly component is ${size} bytes; maximum is ${MAX_PRODUCTION_COMPONENT_BYTES} bytes (5 MiB)`;
            if (process.env.PUMPKIN_PLUGINS_FAIL_ON_SIZE_LIMIT === '1') throw new BuildError(message);
            options.onOutput?.({ type: 'warning', message });
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

function bundleError(error: unknown, entry: string): BuildError {
    // esbuild prints a build failure's errors with source locations before rejecting.
    if (!isBuildFailure(error)) {
        return new BuildError(
            `esbuild could not bundle ${entry}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    const wasiHint = error.errors.some((message) => message.text.startsWith('wasi:')) ? ` ${WASI_CAPABILITY_HINT}` : '';
    return new BuildError(`esbuild could not bundle ${entry}.${wasiHint}`);
}

function isBuildFailure(error: unknown): error is esbuild.BuildFailure {
    return error instanceof Error && 'errors' in error && Array.isArray(error.errors);
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

function bundledFiles(metafile: esbuild.Metafile): string[] {
    // The Static Hermes facades for pumpkin: and wasi: imports are generated from WIT, not plugin code.
    return Object.keys(metafile.inputs)
        .filter((input) => !/^pumpkin-static-hermes-[\w-]+:/.test(input))
        .map((input) => path.resolve(input));
}

function staticHermesWasiImports(metafile: esbuild.Metafile | undefined): string[] {
    const imports = Object.values(metafile?.outputs ?? {}).flatMap((output) => output.imports);
    return [
        ...new Set(
            imports.filter((entry) => entry.external && entry.path.startsWith('wasi:')).map((entry) => entry.path),
        ),
    ];
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
    preserveForRecovery: () => void,
): void {
    try {
        fs.renameSync(component, output);
    } catch (error) {
        if (!isReplaceError(error) || !fs.existsSync(output)) throw error;
        const existing = fs.lstatSync(output);
        if (!existing.isFile() && !existing.isSymbolicLink()) throw error;

        const previous = path.join(temporaryDir, 'previous.wasm');
        replaceOutput(
            component,
            output,
            previous,
            `could not publish or restore ${output}; previous artifact preserved at ${previous}`,
            preserveForRecovery,
        );
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
