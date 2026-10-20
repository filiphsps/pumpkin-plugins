import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StaticHermesGcVariant, StaticHermesRuntimeVariant } from '@pumpkin-plugins/static-hermes-runtime';
import { CAPABILITIES, type Capability, isCapability } from '@pumpkin-plugins/wasi-capabilities';
import { BuildError } from './errors.ts';

/** JavaScript runtime used to build a plugin component. */
export type PluginEngine = 'quickjs' | 'static-hermes';
/** Static Hermes Runtime profile linked into the plugin component. */
export type StaticHermesRuntime = StaticHermesRuntimeVariant;
/** Static Hermes garbage collector linked into the plugin component. */
export type StaticHermesGc = StaticHermesGcVariant;

/** Settings every engine shares under `pumpkinPlugin`. */
export interface PluginBuildFields {
    /** Source file to bundle. Only needed to build a `.wasm`. */
    entry?: string;
    /** Where to write the `.wasm`. Only needed to build one. */
    output?: string;
    /** The package's version, injected as `__PLUGIN_VERSION__`. */
    version: string;
    /** WASI capabilities the code uses. */
    wasi: Capability[];
}

/**
 * What a package declares under `pumpkinPlugin` in its `package.json`, with defaults applied. The engine
 * defaults to Static Hermes, and a Static Hermes build defaults to the Hades garbage collector. The runtime
 * profile has no default here because the build also reads it from the environment.
 */
export type PluginBuildConfig = PluginBuildFields &
    (
        | { engine: 'quickjs' }
        | { engine: 'static-hermes'; staticHermesGc: StaticHermesGc; staticHermesRuntime?: StaticHermesRuntime }
    );

/**
 * Reads the `pumpkinPlugin` key of a package's `package.json`.
 * @param pluginDir - The package folder.
 * @returns The declared settings.
 * @throws {BuildError} When the package data is invalid.
 */
export function readPluginConfig(pluginDir: string): PluginBuildConfig {
    let pkg: unknown;
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
    } catch (error) {
        if (error instanceof SyntaxError) throw new BuildError(`package.json is not valid JSON (${error.message})`);
        if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error.code === 'ENOENT' || error.code === 'ENOTDIR')
        ) {
            throw new BuildError(`could not read package.json in ${pluginDir}`);
        }
        throw error;
    }
    if (!isRecord(pkg)) throw new BuildError('package.json must contain an object');

    const config = pkg.pumpkinPlugin;
    if (!isRecord(config)) throw new BuildError('package.json needs a "pumpkinPlugin" object');

    if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
        throw new BuildError('package.json needs a non-empty "version" string');
    }

    const entry = optionalRelativePath(config.entry, 'entry');
    const output = optionalRelativePath(config.output, 'output');

    const engine = config.engine === undefined ? 'static-hermes' : config.engine;
    if (engine !== 'quickjs' && engine !== 'static-hermes') {
        throw new BuildError('"pumpkinPlugin.engine" must be "quickjs" or "static-hermes"');
    }

    const staticHermesRuntime = config.staticHermesRuntime;
    if (staticHermesRuntime !== undefined) {
        if (engine !== 'static-hermes')
            throw new BuildError('"pumpkinPlugin.staticHermesRuntime" requires "engine": "static-hermes"');
        if (staticHermesRuntime !== 'full' && staticHermesRuntime !== 'lean') {
            throw new BuildError('"pumpkinPlugin.staticHermesRuntime" must be "full" or "lean"');
        }
    }

    const configuredStaticHermesGc = config.staticHermesGc;
    if (configuredStaticHermesGc !== undefined) {
        if (engine !== 'static-hermes')
            throw new BuildError('"pumpkinPlugin.staticHermesGc" requires "engine": "static-hermes"');
        if (configuredStaticHermesGc !== 'hades' && configuredStaticHermesGc !== 'malloc') {
            throw new BuildError('"pumpkinPlugin.staticHermesGc" must be "hades" or "malloc"');
        }
    }

    const wasiValue = config.wasi === undefined ? [] : config.wasi;
    if (!Array.isArray(wasiValue)) throw new BuildError('"pumpkinPlugin.wasi" must be an array of capability names');
    const wasi: Capability[] = [];
    for (const name of wasiValue) {
        if (typeof name !== 'string') {
            throw new BuildError('"pumpkinPlugin.wasi" must contain only capability names');
        }
        if (!isCapability(name)) {
            throw new BuildError(`unknown wasi capability "${name}" (known: ${Object.keys(CAPABILITIES).join(', ')})`);
        }
        wasi.push(name);
    }
    const fields = { entry, output, wasi, version: pkg.version };
    if (engine === 'quickjs') return { ...fields, engine };
    return {
        ...fields,
        engine,
        staticHermesGc: configuredStaticHermesGc ?? 'hades',
        ...(staticHermesRuntime === undefined ? {} : { staticHermesRuntime }),
    };
}

/**
 * Checks that a config read by {@link readPluginConfig} has what a full build needs.
 * @param config - The declared settings, with paths already validated.
 * @returns The entry and output paths.
 * @throws {BuildError} When either is missing.
 */
export function requireBuildFields(config: PluginBuildFields): { entry: string; output: string } {
    if (!config.entry || !config.output) {
        throw new BuildError('package.json needs "pumpkinPlugin": { "entry": ..., "output": ... } to build');
    }
    return { entry: config.entry, output: config.output };
}

function optionalRelativePath(value: unknown, name: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new BuildError(`"pumpkinPlugin.${name}" must be a relative path`);
    const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
    if (
        value.length === 0 ||
        value.includes('\0') ||
        path.isAbsolute(value) ||
        path.win32.isAbsolute(value) ||
        path.win32.parse(value).root !== '' ||
        normalized === '.' ||
        normalized === '..' ||
        normalized.startsWith('../')
    ) {
        throw new BuildError(`"pumpkinPlugin.${name}" must be a path inside the package`);
    }
    if (name === 'output' && path.posix.extname(normalized).toLowerCase() !== '.wasm') {
        throw new BuildError('"pumpkinPlugin.output" must name a .wasm file');
    }
    return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
