import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { WASI_VERSION } from '@pumpkin-plugins/wasi-capabilities';
import * as esbuild from 'esbuild';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { type StaticHermesImportsOptions, staticHermesImportsPlugin } from './esbuild-plugin.ts';

declare module 'vitest' {
    interface ProvidedContext {
        /** The pinned Pumpkin WIT, resolved by `test/pinned-inputs.mjs` before the workers start. */
        pumpkinWitDir: string;
    }
}

const apiWitDir = inject('pumpkinWitDir');
const temporaryDirectories: string[] = [];
let resolveDir = '';

beforeEach(() => {
    resolveDir = temporaryDirectory('static-hermes-plugin-src-');
});

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

/** Copy the pinned Pumpkin WIT and add WASI interfaces, keyed by `<package>/<interface>.wit`. */
function createWitDir(wasiFiles: Record<string, string>): string {
    const witDir = temporaryDirectory('static-hermes-plugin-wit-');
    fs.cpSync(apiWitDir, witDir, { recursive: true });
    const pluginPath = path.join(witDir, 'plugin.wit');
    const pluginWit = fs.readFileSync(pluginPath, 'utf8');
    const imports = Object.keys(wasiFiles).map((file) => {
        const [packageName, interfaceName] = file.slice(0, -4).split('/');
        return `    import wasi:${packageName}/${interfaceName}@${WASI_VERSION};`;
    });
    const firstExport = /^[ \t]*export /m.exec(pluginWit);
    if (!firstExport) throw new Error('plugin.wit has no export');
    fs.writeFileSync(
        pluginPath,
        `${pluginWit.slice(0, firstExport.index)}${imports.join('\n')}\n${pluginWit.slice(firstExport.index)}`,
    );
    for (const [relativePath, contents] of Object.entries(wasiFiles)) {
        const filePath = path.join(witDir, 'deps', relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents.replaceAll('@WASI_VERSION', `@${WASI_VERSION}`));
    }
    return witDir;
}

async function bundle(
    contents: string,
    plugin: Omit<StaticHermesImportsOptions, 'resolveDir'>,
    external: string[] = [],
): Promise<string> {
    const result = await esbuild.build({
        stdin: { contents, resolveDir, sourcefile: 'plugin.ts' },
        bundle: true,
        format: 'iife',
        write: false,
        plugins: [staticHermesImportsPlugin({ ...plugin, resolveDir })],
        external: ['pumpkin:plugin/*', 'wasi:*', ...external],
    });
    return result.outputFiles[0]?.text ?? '';
}

describe('Static Hermes esbuild plugin', () => {
    it('dispatches a bundled Pumpkin facade call to its host adapter', async () => {
        const code = await bundle(
            "import { blockStateToInfo } from 'pumpkin:plugin/world@0.1.0'; globalThis.result = blockStateToInfo(42);",
            { witDir: apiWitDir },
        );
        const hostResult = { name: 'stone' };
        const blockStateToInfo = vi.fn(() => hostResult);
        const context = { __pumpkinHost: { world: { blockStateToInfo } }, result: undefined as unknown };

        runInNewContext(code, context);

        expect(blockStateToInfo).toHaveBeenCalledWith(42);
        expect(context.result).toBe(hostResult);
    });

    it.each([true, false])('keeps every update-check export when developmentMode=%s', async (developmentMode) => {
        const code = await bundle(
            "import { checkMarketUpdate, registerPluginWithUpdates } from '@pumpkin-plugins/update-check'; registerPluginWithUpdates({ id: 'demo' }); globalThis.check = checkMarketUpdate;",
            { witDir: apiWitDir, developmentMode },
            ['@pumpkin-plugins/update-check'],
        );
        const checkMarketUpdate = vi.fn();
        const registerPluginWithUpdates = vi.fn();
        const context = {
            require: () => ({ checkMarketUpdate, registerPluginWithUpdates }),
            check: undefined as unknown,
        };

        runInNewContext(code, context);

        expect(registerPluginWithUpdates).toHaveBeenCalledWith({ id: 'demo' });
        expect(context.check).toBe(checkMarketUpdate);
    });

    it('routes WASI filesystem preopens through the generated host shim and reports the import', async () => {
        const imports: string[] = [];
        const witDir = createWitDir({
            'filesystem/preopens.wit':
                'package wasi:filesystem@WASI_VERSION; interface preopens { get-directories: func() -> list<u32>; }',
        });
        const code = await bundle(
            `import { getDirectories } from 'wasi:filesystem/preopens@${WASI_VERSION}'; globalThis.mounts = getDirectories();`,
            { witDir, developmentMode: false, onWasiImport: (specifier) => imports.push(specifier) },
        );
        const getDirectories = vi.fn(() => [7, 11]);
        const context = { __pumpkinWasiFilesystemPreopens: { getDirectories }, mounts: undefined as unknown };

        runInNewContext(code, context);

        expect(imports).toEqual([`wasi:filesystem/preopens@${WASI_VERSION}`]);
        expect(getDirectories).toHaveBeenCalledOnce();
        expect(context.mounts).toEqual([7, 11]);
    });

    it('exports WASI functions declared in the plugin WIT interface', async () => {
        const witDir = createWitDir({
            'clocks/monotonic-clock.wit':
                'package wasi:clocks@WASI_VERSION; interface monotonic-clock { now: func() -> u64; resolution: func() -> u64; }',
        });
        const code = await bundle(
            `import { resolution } from 'wasi:clocks/monotonic-clock@${WASI_VERSION}'; globalThis.value = resolution();`,
            { witDir },
        );
        const context = { __pumpkinWasiClocksMonotonicClock: { resolution: () => 5n }, value: undefined as unknown };

        runInNewContext(code, context);

        expect(context.value).toBe(5n);
    });
});
