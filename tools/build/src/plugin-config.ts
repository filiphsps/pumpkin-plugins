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
 * @throws {BuildError} When the key is missing or names a capability that doesn't exist.
 */
export function readPluginConfig(pluginDir: string): PluginBuildConfig {
    const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
    const config = pkg.pumpkinPlugin;
    if (!config) throw new BuildError('package.json needs a "pumpkinPlugin" key');

    const wasi: string[] = config.wasi ?? [];
    for (const name of wasi) {
        if (!isCapability(name)) {
            throw new BuildError(`unknown wasi capability "${name}" (known: ${Object.keys(CAPABILITIES).join(', ')})`);
        }
    }
    return {
        entry: config.entry,
        output: config.output,
        wasi: wasi as Capability[],
        version: pkg.version
    };
}

/**
 * Checks that a config has what a full build needs.
 * @param config - The declared settings.
 * @returns The entry and output paths.
 * @throws {BuildError} When either is missing.
 */
export function requireBuildFields(config: PluginBuildConfig): { entry: string; output: string } {
    if (!config.entry || !config.output) {
        throw new BuildError('package.json needs "pumpkinPlugin": { "entry": ..., "output": ... } to build');
    }
    return { entry: config.entry, output: config.output };
}
