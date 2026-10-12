import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { staticHermesImportsPlugin } from '@pumpkin-plugins/static-hermes-runtime';
import * as esbuild from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';

const apiWitDir = path.resolve(
    import.meta.dirname,
    '../../static-hermes-runtime/node_modules/@pumpkinmc/pumpkin-api-ts/wit/v0.1'
);
const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function createWitDir(wasiFiles: Record<string, string>): string {
    const witDir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-plugin-wit-'));
    temporaryDirectories.push(witDir);
    fs.cpSync(apiWitDir, witDir, { recursive: true });
    const pluginPath = path.join(witDir, 'plugin.wit');
    const pluginWit = fs.readFileSync(pluginPath, 'utf8');
    const imports = Object.keys(wasiFiles).map((file) => {
        const [packageName, interfaceName] = file.slice(0, -4).split('/');
        return `    import wasi:${packageName}/${interfaceName}@0.2.3;`;
    });
    const firstExport = /^[ \t]*export /m.exec(pluginWit);
    if (!firstExport) throw new Error('plugin.wit has no export');
    fs.writeFileSync(
        pluginPath,
        `${pluginWit.slice(0, firstExport.index)}${imports.join('\n')}\n${pluginWit.slice(firstExport.index)}`
    );
    for (const [relativePath, contents] of Object.entries(wasiFiles)) {
        const filePath = path.join(witDir, 'deps', relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents);
    }
    return witDir;
}

describe('Static Hermes esbuild plugin', () => {
    it('generates facades for every imported Pumpkin interface from WIT', async () => {
        const result = await esbuild.build({
            stdin: {
                contents: `
                    import { Command, CommandNode } from 'pumpkin:plugin/command@0.1.0';
                    import { TextComponent } from 'pumpkin:plugin/text@0.1.0';
                    import { blockStateToInfo } from 'pumpkin:plugin/world@0.1.0';
                    const command = new Command(['demo'], 'Demo command');
                    command.then(CommandNode.literal('status'));
                    TextComponent.fromLegacyString('ready').colorNamed('green');
                    blockStateToInfo(0);
                `,
                resolveDir: path.resolve(import.meta.dirname, '../../../packages/distant-horizons-support-pumpkin/src'),
                sourcefile: 'plugin.ts'
            },
            bundle: true,
            format: 'iife',
            write: false,
            minify: false,
            plugins: [
                staticHermesImportsPlugin({ resolveDir: path.resolve(import.meta.dirname, '.'), witDir: apiWitDir })
            ],
            external: ['pumpkin:plugin/*', 'wasi:*']
        });

        const bundle = result.outputFiles[0]?.text ?? '';
        expect(bundle).toContain('__pumpkinHost["command"]');
        expect(bundle).toContain('__pumpkinHost["text"]');
        expect(bundle).toContain('__pumpkinHost["world"]');
        expect(bundle).toContain('blockStateToInfo');
        expect(bundle).not.toContain('__require("pumpkin:plugin/command@0.1.0")');
        expect(bundle).not.toContain('__require("pumpkin:plugin/text@0.1.0")');
        expect(bundle).not.toContain('__require("pumpkin:plugin/world@0.1.0")');
    });

    it('dispatches a bundled Pumpkin facade call to its host adapter', async () => {
        const result = await esbuild.build({
            stdin: {
                contents:
                    "import { blockStateToInfo } from 'pumpkin:plugin/world@0.1.0'; globalThis.result = blockStateToInfo(42);",
                resolveDir: path.resolve(import.meta.dirname, '.'),
                sourcefile: 'plugin.ts'
            },
            bundle: true,
            format: 'iife',
            write: false,
            plugins: [
                staticHermesImportsPlugin({ resolveDir: path.resolve(import.meta.dirname, '.'), witDir: apiWitDir })
            ],
            external: ['pumpkin:plugin/*', 'wasi:*']
        });
        const hostResult = { name: 'stone' };
        const blockStateToInfo = vi.fn(() => hostResult);
        const context = { __pumpkinHost: { world: { blockStateToInfo } }, result: undefined as unknown };

        runInNewContext(result.outputFiles[0]?.text ?? '', context);

        expect(blockStateToInfo).toHaveBeenCalledWith(42);
        expect(context.result).toBe(hostResult);
    });

    it.each([true, false])('routes automatic update checks based on developmentMode=%s', async (developmentMode) => {
        const imports: string[] = [];
        const witDir = createWitDir(
            developmentMode
                ? {}
                : {
                      'http/types.wit': `package wasi:http@0.2.3; interface types {
                          resource fields { constructor(); set: func(name: string); }
                          resource outgoing-request { constructor(headers: fields); set-method: func(); set-scheme: func(); set-authority: func(); set-path-with-query: func(); }
                          resource request-options { constructor(); set-connect-timeout: func(); set-first-byte-timeout: func(); set-between-bytes-timeout: func(); }
                      }`,
                      'http/outgoing-handler.wit':
                          'package wasi:http@0.2.3; interface outgoing-handler { handle: func(request: u32, options: u32); }',
                      'clocks/monotonic-clock.wit':
                          'package wasi:clocks@0.2.3; interface monotonic-clock { now: func() -> u64; }'
                  }
        );
        const result = await esbuild.build({
            stdin: {
                contents:
                    "import { registerPluginWithUpdates } from '@pumpkin-plugins/update-check'; registerPluginWithUpdates({});",
                resolveDir: path.resolve(import.meta.dirname, '../../plugin-kit/src'),
                sourcefile: 'plugin.ts'
            },
            bundle: true,
            format: 'iife',
            write: false,
            minify: false,
            plugins: [
                staticHermesImportsPlugin({
                    resolveDir: path.resolve(import.meta.dirname, '../../../packages/apple-skin-pumpkin/src'),
                    witDir,
                    developmentMode,
                    onWasiImport: (specifier) => imports.push(specifier)
                })
            ],
            external: ['pumpkin:plugin/*', 'wasi:*'],
            define: { __PUMPKIN_DEV_MODE__: JSON.stringify(developmentMode) }
        });

        expect(result.outputFiles[0]?.text).toContain('registerPlugin(');
        if (developmentMode) {
            expect(result.outputFiles[0]?.text).not.toContain('Market response is too large');
            expect(imports).toEqual([]);
        } else {
            expect(result.outputFiles[0]?.text).toContain('Market response is too large');
            expect(result.outputFiles[0]?.text).toContain('__pumpkinWasiHttpTypes');
            expect(imports).toContain('wasi:http/outgoing-handler@0.2.3');
            expect(imports).toContain('wasi:http/types@0.2.3');
            expect(imports).toContain('wasi:clocks/monotonic-clock@0.2.3');
        }
    });

    it('routes WASI filesystem preopens through the generated JSI host shim', async () => {
        const imports: string[] = [];
        const witDir = createWitDir({
            'filesystem/preopens.wit':
                'package wasi:filesystem@0.2.3; interface preopens { get-directories: func() -> list<u32>; }'
        });
        const result = await esbuild.build({
            stdin: {
                contents:
                    "import { getDirectories } from 'wasi:filesystem/preopens@0.2.3'; globalThis.mounts = getDirectories();",
                resolveDir: path.resolve(import.meta.dirname, '../../../packages/distant-horizons-support-pumpkin/src'),
                sourcefile: 'plugin.ts'
            },
            bundle: true,
            format: 'iife',
            write: false,
            minify: false,
            plugins: [
                staticHermesImportsPlugin({
                    resolveDir: path.resolve(
                        import.meta.dirname,
                        '../../../packages/distant-horizons-support-pumpkin/src'
                    ),
                    witDir,
                    developmentMode: false,
                    onWasiImport: (specifier) => imports.push(specifier)
                })
            ],
            external: ['pumpkin:plugin/*', 'wasi:*']
        });

        const bundle = result.outputFiles[0]?.text ?? '';
        expect(bundle).toContain('__pumpkinWasiFilesystemPreopens');
        expect(bundle).toContain('__staticHermesWasiError');
        expect(bundle).toContain('error.payload = errorCode');
        expect(bundle).not.toContain('__require("wasi:filesystem/preopens@0.2.3")');
        expect(imports).toEqual(['wasi:filesystem/preopens@0.2.3']);

        const getDirectories = vi.fn(() => [7, 11]);
        const context = { __pumpkinWasiFilesystemPreopens: { getDirectories }, mounts: undefined as unknown };
        runInNewContext(bundle, context);

        expect(getDirectories).toHaveBeenCalledOnce();
        expect(context.mounts).toEqual([7, 11]);
    });

    it('generates WASI module exports from the plugin WIT interface', async () => {
        const witDir = createWitDir({
            'clocks/monotonic-clock.wit':
                'package wasi:clocks@0.2.3; interface monotonic-clock { now: func() -> u64; resolution: func() -> u64; }'
        });

        const result = await esbuild.build({
            stdin: {
                contents:
                    "import { resolution } from 'wasi:clocks/monotonic-clock@0.2.3'; globalThis.value = resolution();",
                resolveDir: path.resolve(import.meta.dirname, '.'),
                sourcefile: 'plugin.ts'
            },
            bundle: true,
            format: 'iife',
            write: false,
            minify: false,
            plugins: [staticHermesImportsPlugin({ resolveDir: path.resolve(import.meta.dirname, '.'), witDir })],
            external: ['pumpkin:plugin/*', 'wasi:*']
        });

        const bundle = result.outputFiles[0]?.text ?? '';
        expect(bundle).toContain('__pumpkinWasiClocksMonotonicClock');
        expect(bundle).toContain('resolution');
        expect(bundle).not.toContain('globalThis.__pumpkinWasiClocksMonotonicClock["now"]');
    });
});
