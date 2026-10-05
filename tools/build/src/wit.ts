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
    /** Exact WASI WIT paths from the lock, to keep stale cached files out of the component world. */
    wasiFiles?: readonly string[];
}

/**
 * Prepares the WIT a plugin is built against: the API's own, plus WASI imports and the WASI
 * packages they refer to when the plugin asked for any.
 * @param options - What to combine and where.
 * @returns The folder to build against. It is the API's folder itself when nothing was added.
 */
export function prepareWit(options: PrepareWitOptions): string {
    if (options.interfaces.length === 0) return options.apiWit;
    const { wasiWit } = options;
    if (!wasiWit) {
        throw new BuildError('the WASI WIT files are needed but were not provided');
    }

    const parent = path.dirname(options.target);
    fs.mkdirSync(parent, { recursive: true });
    const temporary = fs.mkdtempSync(path.join(parent, `.${path.basename(options.target)}-`));
    try {
        retryTransientCopy(
            () => fs.cpSync(options.apiWit, temporary, { recursive: true }),
            () => {
                fs.rmSync(temporary, { recursive: true, force: true });
                fs.mkdirSync(temporary);
            }
        );

        if (options.wasiFiles) {
            for (const rel of options.wasiFiles) {
                const target = path.join(temporary, 'deps', rel);
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.copyFileSync(path.join(wasiWit, rel), target);
            }
        } else {
            const deps = path.join(temporary, 'deps');
            retryTransientCopy(
                () => fs.cpSync(wasiWit, deps, { recursive: true }),
                () => fs.rmSync(deps, { recursive: true, force: true })
            );
        }
        if (options.interfaces.includes('http/outgoing-handler')) {
            fs.copyFileSync(
                path.join(import.meta.dirname, '../wit/http-package.wit'),
                path.join(temporary, 'deps/http/package.wit')
            );
        }
        const pluginWit = path.join(temporary, 'plugin.wit');
        fs.writeFileSync(pluginWit, injectWasiImports(fs.readFileSync(pluginWit, 'utf8'), options.interfaces));
        fs.rmSync(options.target, { recursive: true, force: true });
        fs.renameSync(temporary, options.target);
    } catch (error) {
        fs.rmSync(temporary, { recursive: true, force: true });
        throw error;
    }
    return options.target;
}

function retryTransientCopy(copy: () => void, reset: () => void): void {
    for (let attempt = 0; ; attempt += 1) {
        try {
            copy();
            return;
        } catch (error) {
            if (!isInputOutputError(error) || attempt === 2) throw error;
            reset();
        }
    }
}

function isInputOutputError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EIO';
}
