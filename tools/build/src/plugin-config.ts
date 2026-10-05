import * as fs from 'node:fs';
import * as path from 'node:path';
import { CAPABILITIES, type Capability, isCapability } from './capabilities.ts';
import { BuildError } from './errors.ts';

/** What a package declares under `pumpkinPlugin` in its `package.json`. */
export interface PluginBuildConfig {
    /** Source file to bundle. Only needed to build a `.wasm`. */
    entry?: string;
    /** Where to write the `.wasm`. Only needed to build one. */
    output?: string;
    /** WASI capabilities the code uses. */
    wasi: Capability[];
    /** The package's version, injected as `__PLUGIN_VERSION__`. */
    version: string;
}

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
    return {
        entry,
        output,
        wasi,
        version: pkg.version
    };
}

/**
 * Checks that a config has what a full build needs.
 * @param config - The declared settings.
 * @returns The entry and output paths.
 * @throws {BuildError} When either is missing or invalid.
 */
export function requireBuildFields(config: PluginBuildConfig): { entry: string; output: string } {
    if (!config.entry || !config.output) {
        throw new BuildError('package.json needs "pumpkinPlugin": { "entry": ..., "output": ... } to build');
    }
    return {
        entry: requiredRelativePath(config.entry, 'entry'),
        output: requiredRelativePath(config.output, 'output')
    };
}

function optionalRelativePath(value: unknown, name: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new BuildError(`"pumpkinPlugin.${name}" must be a relative path`);
    return requiredRelativePath(value, name);
}

function requiredRelativePath(value: unknown, name: string): string {
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
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
