import * as fs from 'node:fs';
import * as path from 'node:path';
import { WASI_VERSION } from './capabilities.ts';
import { BuildError } from './errors.ts';

/**
 * Adds WASI imports to the `plugin` world, just before its first export.
 * @param pluginWit - The text of `plugin.wit`.
 * @param interfaces - Interfaces as `package/interface`, such as `io/poll`.
 * @returns The changed text.
 * @throws {BuildError} When the file has no export to anchor on, which means the API layout changed.
 */
export function injectWasiImports(pluginWit: string, interfaces: readonly string[]): string {
    const firstExport = /^[ \t]*export /m.exec(pluginWit);
    if (!firstExport) throw new BuildError('could not find the exports in plugin.wit; the API layout changed');
    const imports = interfaces.map((i) => {
        const [pkg, name] = i.split('/');
        return `    import wasi:${pkg}/${name}@${WASI_VERSION};`;
    });
    const header = `    // --- WASI (added by pumpkin-plugins-build) ---\n${imports.join('\n')}\n\n`;
    return `${pluginWit.slice(0, firstExport.index)}${header}${pluginWit.slice(firstExport.index)}`;
}

/** Inputs to `prepareWit`. */
export interface PrepareWitOptions {
    /** The API package's `wit/v0.1` folder. */
    apiWit: string;
    /** Where to write the combined WIT, when there is anything to add. */
    target: string;
    /** WASI interfaces to import. */
    interfaces: readonly string[];
    /** The folder `ensureWasiWit` returned. Only needed when there are interfaces. */
    wasiWit?: string;
}

/**
 * Prepares the WIT a plugin is built against: the API's own, plus WASI imports and the WASI
 * packages they refer to when the plugin asked for any.
 * @param options - What to combine and where.
 * @returns The folder to build against. It is the API's folder itself when nothing was added.
 */
export function prepareWit(options: PrepareWitOptions): string {
    if (options.interfaces.length === 0) return options.apiWit;
    if (options.interfaces.length > 0 && !options.wasiWit) {
        throw new BuildError('the WASI WIT files are needed but were not provided');
    }

    fs.rmSync(options.target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(options.target), { recursive: true });
    fs.cpSync(options.apiWit, options.target, { recursive: true });

    if (options.interfaces.length > 0 && options.wasiWit) {
        fs.cpSync(options.wasiWit, path.join(options.target, 'deps'), { recursive: true });
        const pluginWit = path.join(options.target, 'plugin.wit');
        fs.writeFileSync(pluginWit, injectWasiImports(fs.readFileSync(pluginWit, 'utf8'), options.interfaces));
    }
    return options.target;
}
