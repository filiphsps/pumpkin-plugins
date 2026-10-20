import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('esbuild', () => ({ build: vi.fn() }));
vi.mock('./types.ts', () => ({ generateTypes: vi.fn() }));
vi.mock('./wit-method-usage.ts', () => ({ findUsedWitMethods: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:fs')>();
    return { ...original, renameSync: vi.fn(original.renameSync) };
});

import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { bundlePlugin } from './bundle.ts';
import { BuildError } from './errors.ts';
import { generateTypes } from './types.ts';
import { findUsedWitMethods } from './wit-method-usage.ts';

const dirs: string[] = [];
const apiWitDir = path.join(os.tmpdir(), 'pumpkin-api-wit-fixture');
const MAX_PRODUCTION_COMPONENT_BYTES = 5 * 1024 * 1024;
const engineProfiles = [
    { name: 'QuickJS', options: { engine: 'quickjs' } },
    { name: 'Static Hermes default runtime', options: { engine: 'static-hermes' } },
    { name: 'Static Hermes full runtime', options: { engine: 'static-hermes', staticHermesRuntime: 'full' } },
    { name: 'Static Hermes lean runtime', options: { engine: 'static-hermes', staticHermesRuntime: 'lean' } },
    { name: 'Static Hermes malloc collector', options: { engine: 'static-hermes', staticHermesGc: 'malloc' } },
] as const;
const componentize = vi.mocked(execFileSync);
const esbuild = vi.mocked(build);

async function failure(promise: Promise<unknown>): Promise<Error> {
    const error: unknown = await promise.then(
        () => undefined,
        (rejection: unknown) => rejection,
    );
    if (!(error instanceof Error)) throw new Error('expected the build to fail');
    return error;
}

beforeEach(() => {
    esbuild.mockResolvedValue({} as never);
    componentize.mockImplementation((_file, args) => {
        const outputIndex = args?.indexOf('--output') ?? -1;
        const output = args?.[outputIndex + 1];
        if (!output) throw new Error('missing componentizer output argument');
        fs.writeFileSync(output, 'component');
        return Buffer.alloc(0);
    });
});

afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function buildAt(name = 'plugin.wasm'): { dir: string; output: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-build-'));
    dirs.push(dir);
    return { dir, output: path.join(dir, name) };
}

describe('bundlePlugin', () => {
    it.each(engineProfiles)('captures $name output and reports componentization centrally', async ({ options }) => {
        const { output } = buildAt();
        const onOutput = vi.fn();
        esbuild.mockImplementationOnce((buildOptions) => {
            if (!buildOptions.outfile) throw new Error('missing JavaScript bundle output');
            fs.writeFileSync(
                buildOptions.outfile,
                'var __pumpkinPlugin=(()=>{var exports={};return wrap(exports);})();',
            );
            return {} as never;
        });

        await bundlePlugin({
            entry: 'src/plugin.ts',
            output,
            witDir: apiWitDir,
            version: '1.0.0',
            quietRuntimeOutput: true,
            onOutput,
            ...options,
        });

        const engine = options.engine;
        const runtimeVariant = 'staticHermesRuntime' in options ? options.staticHermesRuntime : undefined;
        const gcVariant = 'staticHermesGc' in options ? options.staticHermesGc : undefined;
        expect(componentize.mock.calls[0]?.[2]).toEqual({
            stdio: ['inherit', 'ignore', 'pipe'],
            maxBuffer: 16 * 1024 * 1024,
        });
        expect(componentize.mock.calls[0]?.[1]).not.toContain('--parse-ts');
        expect(onOutput).toHaveBeenCalledWith({
            type: 'componentize',
            engine,
            ...(runtimeVariant === undefined ? {} : { runtimeVariant }),
            ...(gcVariant === undefined ? {} : { gcVariant }),
        });
        if (gcVariant === undefined) expect(componentize.mock.calls[0]?.[1]).not.toContain('--gc-variant');
        else {
            expect(componentize.mock.calls[0]?.[1]).toContain('--gc-variant');
            expect(componentize.mock.calls[0]?.[1]).toContain(gcVariant);
        }
    });

    it('reports selected Static Hermes methods and events when runtime output is enabled', async () => {
        const { output } = buildAt();
        const onOutput = vi.fn();
        esbuild.mockImplementationOnce((buildOptions) => {
            if (!buildOptions.outfile) throw new Error('missing JavaScript bundle output');
            fs.writeFileSync(
                buildOptions.outfile,
                'var __pumpkinPlugin=(()=>{var exports={};return wrap(exports);})();',
            );
            return { metafile: { inputs: {}, outputs: { [buildOptions.outfile]: { imports: [] } } } } as never;
        });
        vi.mocked(findUsedWitMethods).mockReturnValue({
            pumpkinMethods: ['player.player.get-position'],
            wasiMethods: ['wasi:filesystem/types@0.2.3#read-via-stream'],
            eventTypes: ['server-tick-end-event'],
        });

        await bundlePlugin({
            entry: 'src/plugin.ts',
            output,
            witDir: apiWitDir,
            version: '1.0.0',
            engine: 'static-hermes',
            quietRuntimeOutput: false,
            onOutput,
        });

        expect(onOutput).toHaveBeenCalledWith({
            type: 'componentize',
            engine: 'static-hermes',
            selections: {
                wasiImports: [],
                wasiMethods: ['wasi:filesystem/types@0.2.3#read-via-stream'],
                apiMethods: ['player.player.get-position'],
                eventTypes: ['server-tick-end-event'],
            },
        });
    });

    it('preserves captured QuickJS diagnostics for the build output handler', async () => {
        const { output } = buildAt();
        componentize.mockImplementationOnce(() => {
            throw Object.assign(new Error('componentizer failed'), { stderr: Buffer.from('link failed') });
        });

        await expect(
            bundlePlugin({
                entry: 'src/plugin.ts',
                output,
                witDir: apiWitDir,
                version: '1.0.0',
                engine: 'quickjs',
                quietRuntimeOutput: true,
            }),
        ).rejects.toThrow('QuickJS componentizer failed:\nlink failed');
    });

    it('passes the bundle, WIT and workspace root to the Static Hermes componentizer', async () => {
        const { dir, output } = buildAt();
        esbuild.mockImplementationOnce((options) => {
            if (!options.outfile) throw new Error('missing JavaScript bundle output');
            fs.writeFileSync(options.outfile, 'var __pumpkinPlugin=(()=>{var exports={};return wrap(exports);})();');
            return {} as never;
        });

        await bundlePlugin({
            projectRoot: dir,
            entry: 'src/plugin.ts',
            output,
            witDir: apiWitDir,
            version: '1.0.0',
            engine: 'static-hermes',
        });

        expect(esbuild).toHaveBeenCalledWith(expect.objectContaining({ format: 'iife' }));
        expect(componentize.mock.calls[0]?.[1]).toEqual(
            expect.arrayContaining([
                expect.stringContaining('dist/cli.js'),
                'component',
                'build',
                '--bundle',
                expect.any(String),
                '--wit',
                apiWitDir,
                '--output',
                expect.any(String),
                '--workspace-root',
                dir,
                '--wasi-imports',
                '[]',
            ]),
        );
    });

    it('selects Static Hermes adapters from the bundled plugin files and isolated WIT declarations', async () => {
        const { output } = buildAt();
        esbuild.mockImplementationOnce((buildOptions) => {
            if (!buildOptions.outfile) throw new Error('missing JavaScript bundle output');
            fs.writeFileSync(
                buildOptions.outfile,
                'var __pumpkinPlugin=(()=>{var exports={};return wrap(exports);})();',
            );
            return {
                metafile: {
                    inputs: {
                        'src/plugin.ts': {},
                        'node_modules/helper/index.js': {},
                        'pumpkin-static-hermes-api:pumpkin:plugin/player@0.1.0': {},
                    },
                    outputs: {},
                },
            } as never;
        });

        await bundlePlugin({
            entry: 'src/plugin.ts',
            output,
            witDir: apiWitDir,
            version: '1.0.0',
            engine: 'static-hermes',
        });

        const generatedTypesDir = vi.mocked(generateTypes).mock.calls[0]?.[1];
        if (!generatedTypesDir) throw new Error('missing generated WIT declarations directory');
        expect(generateTypes).toHaveBeenCalledWith(apiWitDir, generatedTypesDir);
        expect(generatedTypesDir).toMatch(/\.pumpkin-build-[^/\\]+[\\/]wit-types$/);
        expect(findUsedWitMethods).toHaveBeenCalledWith({
            entry: 'src/plugin.ts',
            inputs: [path.resolve('src/plugin.ts'), path.resolve('node_modules/helper/index.js')],
            typesDir: generatedTypesDir,
            witDir: apiWitDir,
        });
        expect(fs.existsSync(path.dirname(generatedTypesDir))).toBe(false);
    });

    it('defines development mode in plugin bundles', async () => {
        const { output } = buildAt();

        await bundlePlugin({
            entry: 'src/plugin.ts',
            output,
            witDir: 'wit',
            version: '1.0.0',
            engine: 'quickjs',
            developmentMode: true,
        });

        expect(esbuild).toHaveBeenCalledWith(
            expect.objectContaining({
                define: {
                    __PLUGIN_VERSION__: JSON.stringify('1.0.0'),
                    __PUMPKIN_DEV_MODE__: JSON.stringify(true),
                    'process.env.NODE_ENV': JSON.stringify('development'),
                },
                treeShaking: true,
                minify: false,
            }),
        );
    });

    it('builds Static Hermes plugins as a bundled IIFE and bypasses QuickJS componentization', async () => {
        const { output } = buildAt();
        const onOutput = vi.fn();
        esbuild.mockImplementationOnce((options) => {
            if (!options.outfile) throw new Error('missing JavaScript bundle output');
            fs.writeFileSync(options.outfile, 'var __pumpkinPlugin=(()=>{var exports={};return wrap(exports);})();');
            return {} as never;
        });
        componentize.mockImplementation((_file, args) => {
            const bundleIndex = args?.indexOf('--bundle') ?? -1;
            const bundlePath = args?.[bundleIndex + 1];
            if (!bundlePath) throw new Error('missing Static Hermes bundle argument');
            expect(fs.readFileSync(bundlePath, 'utf8')).toBe(
                'var __pumpkinPlugin=(()=>{var exports={};return exports;})();',
            );
            const outputIndex = args?.indexOf('--output') ?? -1;
            const staged = args?.[outputIndex + 1];
            if (!staged) throw new Error('missing Static Hermes output argument');
            fs.writeFileSync(staged, 'component');
            return Buffer.alloc(0);
        });

        await bundlePlugin({
            entry: 'src/plugin.ts',
            output,
            witDir: apiWitDir,
            version: '1.0.0',
            engine: 'static-hermes',
            staticHermesRuntime: 'lean',
            parseTypeScript: true,
            onOutput,
        });

        expect(esbuild).toHaveBeenCalledWith(
            expect.objectContaining({ format: 'iife', globalName: '__pumpkinPlugin', bundle: true }),
        );
        expect(componentize.mock.calls[0]?.[1]).toContainEqual(expect.stringContaining('dist/cli.js'));
        expect(componentize.mock.calls[0]?.[1]).toContain('component');
        expect(componentize.mock.calls[0]?.[1]).toContain('build');
        expect(componentize.mock.calls[0]?.[1]).toContain('--runtime-variant');
        expect(componentize.mock.calls[0]?.[1]).toContain('lean');
        expect(componentize.mock.calls[0]?.[1]).toContain('--parse-ts');
        expect(componentize.mock.calls[0]?.[1]).not.toContainEqual(expect.stringContaining('componentize-qjs.cjs'));
        expect(onOutput).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'componentize',
                engine: 'static-hermes',
                runtimeVariant: 'lean',
                parseTypeScript: true,
            }),
        );
    });

    it('allows WASI-looking string literals in Static Hermes bundles', async () => {
        const { output } = buildAt();
        esbuild.mockImplementationOnce((options) => {
            if (!options.outfile) throw new Error('missing JavaScript bundle output');
            fs.writeFileSync(
                options.outfile,
                'var __pumpkinPlugin=(()=>{var note="wasi:http/types@0.2.3";var exports={};return wrap(exports);})();',
            );
            return {
                metafile: {
                    inputs: {},
                    outputs: { [options.outfile]: { imports: [] } },
                },
            } as never;
        });

        await bundlePlugin({
            entry: 'src/plugin.ts',
            output,
            witDir: apiWitDir,
            version: '1.0.0',
            engine: 'static-hermes',
        });

        expect(componentize).toHaveBeenCalled();
    });

    it('unwraps Static Hermes bundles with trailing esbuild license comments', async () => {
        const { output } = buildAt();
        esbuild.mockImplementationOnce((options) => {
            if (!options.outfile) throw new Error('missing JavaScript bundle output');
            fs.writeFileSync(
                options.outfile,
                'var __pumpkinPlugin=(()=>{var exports={};return wrap(exports);})();\n/*! Bundled license information */\n',
            );
            return {} as never;
        });
        componentize.mockImplementation((_file, args) => {
            const bundleIndex = args?.indexOf('--bundle') ?? -1;
            const bundlePath = args?.[bundleIndex + 1];
            if (!bundlePath) throw new Error('missing Static Hermes bundle argument');
            const bundle = fs.readFileSync(bundlePath, 'utf8');
            expect(bundle).toContain('return exports;');
            expect(bundle).toContain('/*! Bundled license information */');
            const outputIndex = args?.indexOf('--output') ?? -1;
            const staged = args?.[outputIndex + 1];
            if (!staged) throw new Error('missing Static Hermes output argument');
            fs.writeFileSync(staged, 'component');
            return Buffer.alloc(0);
        });

        await bundlePlugin({
            entry: 'src/plugin.ts',
            output,
            witDir: apiWitDir,
            version: '1.0.0',
            engine: 'static-hermes',
        });
    });

    it('rejects Static Hermes bundles with unresolved WASI imports before compiling', async () => {
        const { output } = buildAt();
        esbuild.mockImplementationOnce((options) => {
            if (!options.outfile) throw new Error('missing JavaScript bundle output');
            fs.writeFileSync(options.outfile, 'var plugin = require("wasi:http/types@0.2.3");');
            return {
                metafile: {
                    outputs: {
                        [options.outfile]: {
                            imports: [{ path: 'wasi:http/types@0.2.3', external: true }],
                        },
                    },
                },
            } as never;
        });

        const error = await failure(
            bundlePlugin({
                entry: 'src/plugin.ts',
                output,
                witDir: apiWitDir,
                version: '1.0.0',
                engine: 'static-hermes',
            }),
        );

        expect(error).toBeInstanceOf(BuildError);
        expect(error.message).toContain('wasi:http/types@0.2.3');
        expect(error.message).toContain('pumpkinPlugin.wasi');

        expect(esbuild).toHaveBeenCalledWith(expect.objectContaining({ metafile: true }));
        expect(componentize).not.toHaveBeenCalled();
        expect(fs.existsSync(output)).toBe(false);
    });

    it('reports esbuild failures as build errors', async () => {
        const { output } = buildAt();
        esbuild.mockRejectedValueOnce(
            Object.assign(new Error('Build failed with 1 error'), {
                errors: [{ text: 'Expected identifier but found "="' }],
                warnings: [],
            }),
        );

        const error = await failure(
            bundlePlugin({ entry: 'src/plugin.ts', output, witDir: 'wit', version: '1.0.0', engine: 'quickjs' }),
        );

        expect(error).toBeInstanceOf(BuildError);
        expect(error.message).toContain('src/plugin.ts');
        expect(componentize).not.toHaveBeenCalled();
    });

    it('points at pumpkinPlugin.wasi when esbuild cannot resolve a WASI import', async () => {
        const { output } = buildAt();
        esbuild.mockRejectedValueOnce(
            Object.assign(new Error('Build failed with 1 error'), {
                errors: [{ text: "wasi:http/types@0.2.3 is not imported or referenced by the plugin's WIT world" }],
                warnings: [],
            }),
        );

        const error = await failure(
            bundlePlugin({
                entry: 'src/plugin.ts',
                output,
                witDir: apiWitDir,
                version: '1.0.0',
                engine: 'static-hermes',
            }),
        );

        expect(error).toBeInstanceOf(BuildError);
        expect(error.message).toContain('pumpkinPlugin.wasi');
    });

    it.each(['quickjs', 'static-hermes'] as const)(
        'reports %s componentizer failures as build errors when runtime output is shown',
        async (engine) => {
            const { output } = buildAt();
            esbuild.mockImplementationOnce((buildOptions) => {
                if (!buildOptions.outfile) throw new Error('missing JavaScript bundle output');
                fs.writeFileSync(
                    buildOptions.outfile,
                    'var __pumpkinPlugin=(()=>{var exports={};return wrap(exports);})();',
                );
                return {} as never;
            });
            componentize.mockImplementation(() => {
                throw Object.assign(new Error('Command failed'), { status: 1 });
            });

            const error = await failure(
                bundlePlugin({
                    entry: 'src/plugin.ts',
                    output,
                    witDir: apiWitDir,
                    version: '1.0.0',
                    engine,
                    quietRuntimeOutput: false,
                }),
            );

            expect(error).toBeInstanceOf(BuildError);
            expect(error.message).toContain('exit 1');
        },
    );

    it('publishes a completed component and returns its size', async () => {
        const { output } = buildAt();
        fs.writeFileSync(output, 'old artifact');

        const size = await bundlePlugin({
            entry: 'src/plugin.ts',
            output,
            witDir: 'wit',
            version: '1.0.0',
            engine: 'quickjs',
        });

        expect(size).toBe(Buffer.byteLength('component'));
        expect(fs.readFileSync(output, 'utf8')).toBe('component');
        expect(fs.readdirSync(path.dirname(output))).toEqual(['plugin.wasm']);
        expect(esbuild).toHaveBeenCalledWith(
            expect.objectContaining({
                minify: true,
                treeShaking: true,
                define: expect.objectContaining({ 'process.env.NODE_ENV': JSON.stringify('production') }),
            }),
        );
    });

    it('removes abandoned staging directories from earlier builds', async () => {
        const { dir, output } = buildAt();
        const abandoned = path.join(dir, '.pumpkin-build-2147483647-abandoned');
        fs.mkdirSync(abandoned);
        fs.writeFileSync(path.join(abandoned, 'bundle.js'), 'leftover bundle');

        await bundlePlugin({
            entry: 'src/plugin.ts',
            output,
            witDir: 'wit',
            version: '1.0.0',
            engine: 'quickjs',
        });

        expect(fs.existsSync(abandoned)).toBe(false);
    });

    it('removes old staging directories created before owner tracking', async () => {
        const { dir, output } = buildAt();
        const abandoned = fs.mkdtempSync(path.join(dir, '.pumpkin-build-'));
        const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
        fs.utimesSync(abandoned, old, old);

        await bundlePlugin({
            entry: 'src/plugin.ts',
            output,
            witDir: 'wit',
            version: '1.0.0',
            engine: 'quickjs',
        });

        expect(fs.existsSync(abandoned)).toBe(false);
    });

    it.each(engineProfiles)('allows a $name production component exactly at the 5 MiB limit', async ({ options }) => {
        const { output } = buildAt();
        const limit = MAX_PRODUCTION_COMPONENT_BYTES;
        esbuild.mockImplementationOnce((buildOptions) => {
            if (!buildOptions.outfile) throw new Error('missing JavaScript bundle output');
            fs.writeFileSync(
                buildOptions.outfile,
                'var __pumpkinPlugin=(()=>{var exports={};return wrap(exports);})();',
            );
            return {} as never;
        });
        componentize.mockImplementation((_file, args) => {
            const outputIndex = args?.indexOf('--output') ?? -1;
            const staged = args?.[outputIndex + 1];
            if (!staged) throw new Error('missing componentizer output argument');
            fs.writeFileSync(staged, '');
            fs.truncateSync(staged, limit);
            return Buffer.alloc(0);
        });

        const size = await bundlePlugin({
            entry: 'src/plugin.ts',
            output,
            witDir: apiWitDir,
            version: '1.0.0',
            ...options,
        });

        expect(size).toBe(limit);
        expect(fs.statSync(output).size).toBe(limit);
    });

    it.each(engineProfiles)(
        'rejects oversized $name production components without replacing the previous artifact when the size limit is enforced',
        async ({ options }) => {
            // A project opts in to the size limit with this variable; without it the build only warns.
            vi.stubEnv('PUMPKIN_PLUGINS_FAIL_ON_SIZE_LIMIT', '1');
            const { output } = buildAt();
            const limit = MAX_PRODUCTION_COMPONENT_BYTES;
            fs.writeFileSync(output, 'known-good artifact');
            esbuild.mockImplementationOnce((buildOptions) => {
                if (!buildOptions.outfile) throw new Error('missing JavaScript bundle output');
                fs.writeFileSync(
                    buildOptions.outfile,
                    'var __pumpkinPlugin=(()=>{var exports={};return wrap(exports);})();',
                );
                return {} as never;
            });
            componentize.mockImplementation((_file, args) => {
                const outputIndex = args?.indexOf('--output') ?? -1;
                const staged = args?.[outputIndex + 1];
                if (!staged) throw new Error('missing componentizer output argument');
                fs.writeFileSync(staged, '');
                fs.truncateSync(staged, limit + 1);
                return Buffer.alloc(0);
            });

            const error = await failure(
                bundlePlugin({ entry: 'src/plugin.ts', output, witDir: apiWitDir, version: '1.0.0', ...options }),
            );

            expect(error).toBeInstanceOf(BuildError);
            expect(error.message).toContain(`${MAX_PRODUCTION_COMPONENT_BYTES + 1} bytes`);

            expect(fs.readFileSync(output, 'utf8')).toBe('known-good artifact');
            expect(fs.readdirSync(path.dirname(output))).toEqual(['plugin.wasm']);
        },
    );

    it('warns about an oversized production component and still publishes it by default', async () => {
        vi.stubEnv('PUMPKIN_PLUGINS_FAIL_ON_SIZE_LIMIT', '');
        const { output } = buildAt();
        const onOutput = vi.fn();
        const size = MAX_PRODUCTION_COMPONENT_BYTES + 1;
        componentize.mockImplementation((_file, args) => {
            const staged = args?.[(args?.indexOf('--output') ?? -1) + 1];
            if (!staged) throw new Error('missing componentizer output argument');
            fs.writeFileSync(staged, '');
            fs.truncateSync(staged, size);
            return Buffer.alloc(0);
        });

        await expect(
            bundlePlugin({
                entry: 'src/plugin.ts',
                output,
                witDir: 'wit',
                version: '1.0.0',
                engine: 'quickjs',
                onOutput,
            }),
        ).resolves.toBe(size);

        expect(onOutput).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'warning', message: expect.stringContaining(`${size} bytes`) }),
        );
        expect(fs.statSync(output).size).toBe(size);
    });

    it.each(engineProfiles)(
        'does not apply the production size limit to $name development components',
        async ({ options }) => {
            const { output } = buildAt();
            const size = MAX_PRODUCTION_COMPONENT_BYTES + 1;
            esbuild.mockImplementationOnce((buildOptions) => {
                if (!buildOptions.outfile) throw new Error('missing JavaScript bundle output');
                fs.writeFileSync(
                    buildOptions.outfile,
                    'var __pumpkinPlugin=(()=>{var exports={};return wrap(exports);})();',
                );
                return {} as never;
            });
            componentize.mockImplementation((_file, args) => {
                const outputIndex = args?.indexOf('--output') ?? -1;
                const staged = args?.[outputIndex + 1];
                if (!staged) throw new Error('missing componentizer output argument');
                fs.writeFileSync(staged, '');
                fs.truncateSync(staged, size);
                return Buffer.alloc(0);
            });

            await expect(
                bundlePlugin({
                    entry: 'src/plugin.ts',
                    output,
                    witDir: apiWitDir,
                    version: '1.0.0',
                    ...options,
                    developmentMode: true,
                }),
            ).resolves.toBe(size);

            expect(fs.statSync(output).size).toBe(size);
        },
    );

    it('keeps the previous artifact and removes staging files when componentization fails', async () => {
        const { output } = buildAt();
        fs.writeFileSync(output, 'known-good artifact');
        componentize.mockImplementation((_file, args) => {
            const outputIndex = args?.indexOf('--output') ?? -1;
            const staged = args?.[outputIndex + 1];
            if (!staged) throw new Error('missing componentizer output argument');
            fs.writeFileSync(staged, 'partial component');
            throw new Error('componentizer failed');
        });

        await expect(
            bundlePlugin({ entry: 'src/plugin.ts', output, witDir: 'wit', version: '1.0.0', engine: 'quickjs' }),
        ).rejects.toThrow('componentizer failed');

        expect(fs.readFileSync(output, 'utf8')).toBe('known-good artifact');
        expect(fs.readdirSync(path.dirname(output))).toEqual(['plugin.wasm']);
    });

    it('replaces an existing artifact when rename cannot overwrite it directly', async () => {
        const { output } = buildAt();
        fs.writeFileSync(output, 'old artifact');
        vi.mocked(fs.renameSync).mockImplementationOnce(() => {
            throw Object.assign(new Error('access denied'), { code: 'EACCES' });
        });

        const size = await bundlePlugin({
            entry: 'src/plugin.ts',
            output,
            witDir: 'wit',
            version: '1.0.0',
            engine: 'quickjs',
        });

        expect(size).toBe(Buffer.byteLength('component'));
        expect(fs.readFileSync(output, 'utf8')).toBe('component');
        expect(fs.readdirSync(path.dirname(output))).toEqual(['plugin.wasm']);
    });

    it('restores the previous artifact if publishing fails after it was moved aside', async () => {
        const { output } = buildAt();
        fs.writeFileSync(output, 'known-good artifact');
        const rename = vi.mocked(fs.renameSync);
        const actualRename = rename.getMockImplementation();
        if (!actualRename) throw new Error('missing real rename implementation');
        rename
            .mockImplementationOnce(() => {
                throw Object.assign(new Error('access denied'), { code: 'EACCES' });
            })
            .mockImplementationOnce((source, destination) => actualRename(source, destination))
            .mockImplementationOnce(() => {
                throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
            })
            .mockImplementationOnce((source, destination) => actualRename(source, destination));

        await expect(
            bundlePlugin({ entry: 'src/plugin.ts', output, witDir: 'wit', version: '1.0.0', engine: 'quickjs' }),
        ).rejects.toThrow('disk full');

        expect(fs.readFileSync(output, 'utf8')).toBe('known-good artifact');
        expect(fs.readdirSync(path.dirname(output))).toEqual(['plugin.wasm']);
    });

    it('preserves a recovery copy if publishing and restoring both fail', async () => {
        const { output } = buildAt();
        fs.writeFileSync(output, 'known-good artifact');
        const rename = vi.mocked(fs.renameSync);
        const actualRename = rename.getMockImplementation();
        if (!actualRename) throw new Error('missing real rename implementation');
        rename
            .mockImplementationOnce(() => {
                throw Object.assign(new Error('access denied'), { code: 'EACCES' });
            })
            .mockImplementationOnce((source, destination) => actualRename(source, destination))
            .mockImplementationOnce(() => {
                throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
            })
            .mockImplementationOnce(() => {
                throw Object.assign(new Error('read only filesystem'), { code: 'EROFS' });
            });

        const failure: unknown = await bundlePlugin({
            entry: 'src/plugin.ts',
            output,
            witDir: 'wit',
            version: '1.0.0',
            engine: 'quickjs',
        }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(AggregateError);
        const message = (failure as AggregateError).message;
        const recoveryPath = message.split('previous artifact preserved at ')[1];
        expect(recoveryPath).toBeDefined();
        expect(fs.readFileSync(recoveryPath ?? '', 'utf8')).toBe('known-good artifact');

        await bundlePlugin({
            entry: 'src/plugin.ts',
            output: path.join(path.dirname(output), 'next-plugin.wasm'),
            witDir: 'wit',
            version: '1.0.0',
            engine: 'quickjs',
        });

        expect(fs.readFileSync(recoveryPath ?? '', 'utf8')).toBe('known-good artifact');
    });

    it('uses separate temporary bundles for concurrent builds', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-build-'));
        dirs.push(dir);
        const first = { output: path.join(dir, 'first.wasm') };
        const second = { output: path.join(dir, 'second.wasm') };
        const bundles: string[] = [];
        esbuild.mockImplementation(async ({ outfile }) => {
            bundles.push(outfile as string);
            await Promise.resolve();
            fs.writeFileSync(outfile as string, 'bundle');
            return {} as never;
        });
        componentize.mockImplementation((_file, args) => {
            const bundleIndex = args?.indexOf('--js') ?? -1;
            const bundle = args?.[bundleIndex + 1];
            const outputIndex = args?.indexOf('--output') ?? -1;
            const staged = args?.[outputIndex + 1];
            if (!bundle || !staged) throw new Error('missing QuickJS componentizer paths');
            if (!fs.existsSync(bundle)) throw new Error('concurrent build staging was removed');
            fs.writeFileSync(staged, 'component');
            return Buffer.alloc(0);
        });

        await Promise.all([
            bundlePlugin({
                entry: 'src/first.ts',
                output: first.output,
                witDir: 'wit',
                version: '1.0.0',
                engine: 'quickjs',
            }),
            bundlePlugin({
                entry: 'src/second.ts',
                output: second.output,
                witDir: 'wit',
                version: '1.0.0',
                engine: 'quickjs',
            }),
        ]);

        expect(new Set(bundles).size).toBe(2);
        expect(fs.readFileSync(first.output, 'utf8')).toBe('component');
        expect(fs.readFileSync(second.output, 'utf8')).toBe('component');
        expect(fs.readdirSync(dir).sort()).toEqual(['first.wasm', 'second.wasm']);
    });
});
