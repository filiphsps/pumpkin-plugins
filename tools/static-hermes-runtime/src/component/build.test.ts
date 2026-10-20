import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentWitAnalysis } from './analyze.ts';
import { buildComponent } from './build.ts';
import type { ComponentGeneratedFiles } from './generate.ts';

const mocks = vi.hoisted(() => ({
    setupToolchain: vi.fn(),
    prepareHermes: vi.fn(),
    analyze: vi.fn(),
    generate: vi.fn(),
    compile: vi.fn(),
}));

vi.mock('../hermes/toolchain-environment.ts', () => ({
    setupHermesToolchainEnvironment: mocks.setupToolchain,
}));
vi.mock('../hermes/prepare.ts', () => ({ prepareHermes: mocks.prepareHermes }));
vi.mock('./analyze.ts', () => ({ analyzeComponentWit: mocks.analyze }));
vi.mock('./generate.ts', () => ({ generateComponentFiles: mocks.generate }));
vi.mock('./compile.ts', () => ({ compileAndLinkComponent: mocks.compile }));

const environmentKeys = [
    'STATIC_HERMES_CACHE_DIR',
    'STATIC_HERMES_SOURCE_DIR',
    'STATIC_HERMES_HOST_BUILD_DIR',
    'STATIC_HERMES_WASI_BUILD_DIR',
    'STATIC_HERMES_WASI_SDK_PATH',
    'STATIC_HERMES_STACK_SIZE',
    'STATIC_HERMES_ENABLE_LEAN_ARCHIVE',
    'PUMPKIN_PLUGINS_STATIC_HERMES_PREPARED',
    'WASM_TOOLS',
    'WIT_BINDGEN',
];
let originalEnvironment = new Map<string, string | undefined>();
let root = '';
let outputDirectory = '';

beforeEach(() => {
    originalEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
    for (const key of environmentKeys) delete process.env[key];
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-component-build-'));
    outputDirectory = path.join(root, 'output');
    fs.mkdirSync(outputDirectory);
    mocks.setupToolchain.mockReset();
    mocks.prepareHermes.mockReset().mockResolvedValue(undefined);
    mocks.analyze.mockReset().mockReturnValue({ analysis: {} } as ComponentWitAnalysis);
    mocks.generate.mockReset().mockReturnValue({} as ComponentGeneratedFiles);
    mocks.compile.mockReset().mockImplementation(({ options }) => {
        fs.writeFileSync(options.output, 'component');
    });
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    for (const [key, value] of originalEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

describe('buildComponent', () => {
    it('prepares missing Hermes artifacts, defaults to lean, and cleans temporary files', async () => {
        configureToolchain();
        const options = { ...buildOptions(), workspaceRoot: root };

        await buildComponent(options);

        expect(mocks.setupToolchain).toHaveBeenCalledWith(
            expect.objectContaining({
                workspaceRoot: root,
                includeWasiSdk: true,
                includeWitBindgen: true,
                includeWasmTools: true,
            }),
        );
        expect(mocks.prepareHermes).toHaveBeenCalledOnce();
        expect(mocks.prepareHermes).toHaveBeenCalledWith(expect.objectContaining({ workspaceRoot: root }));
        expect(mocks.compile).toHaveBeenCalledWith(
            expect.objectContaining({
                options: expect.objectContaining({
                    output: expect.stringContaining(path.join(outputDirectory, '.static-hermes-')),
                }),
                stackSizeBytes: '262144',
                toolchain: expect.objectContaining({
                    hermesRuntimeArchive: path.join(root, 'wasi-build/lib/libhermesvmlean_a.a'),
                }),
            }),
        );
        expect(fs.readdirSync(outputDirectory)).toEqual(['plugin.wasm']);
    });

    it('preserves an existing component when linking fails', async () => {
        configureToolchain();
        const options = buildOptions();
        fs.writeFileSync(options.output, 'known-good component');
        mocks.compile.mockImplementation(({ options: compileOptions }) => {
            fs.writeFileSync(compileOptions.output, 'partial component');
            throw new Error('component linker failed');
        });

        await expect(buildComponent(options)).rejects.toThrow('component linker failed');

        expect(fs.readFileSync(options.output, 'utf8')).toBe('known-good component');
        expect(mocks.compile.mock.calls[0]?.[0].options.output).not.toBe(options.output);
        expect(fs.readdirSync(outputDirectory)).toEqual(['plugin.wasm']);
    });

    it('creates a missing output directory before preparing the component', async () => {
        configureToolchain();
        const missingOutputDirectory = path.join(root, 'nested', 'output');
        const options = {
            ...buildOptions(),
            output: path.join(missingOutputDirectory, 'plugin.wasm'),
            workspaceRoot: root,
        };
        fs.rmSync(missingOutputDirectory, { recursive: true, force: true });

        await buildComponent(options);

        expect(fs.existsSync(missingOutputDirectory)).toBe(true);
        expect(mocks.generate).toHaveBeenCalledOnce();
        expect(fs.readdirSync(missingOutputDirectory)).toEqual(['plugin.wasm']);
    });

    it('uses the consumer working directory as the default cache workspace', async () => {
        configureToolchain();
        const consumerRoot = path.join(root, 'consumer');
        fs.mkdirSync(consumerRoot);
        const originalWorkingDirectory = process.cwd();
        process.chdir(consumerRoot);
        const expectedWorkspaceRoot = process.cwd();

        try {
            await buildComponent(buildOptions());

            expect(mocks.setupToolchain.mock.calls[0]?.[0].workspaceRoot).toBe(expectedWorkspaceRoot);
        } finally {
            process.chdir(originalWorkingDirectory);
        }
    });

    it('uses the nearest pnpm workspace for a nested consumer and preserves an explicit cache directory', async () => {
        const workspaceRoot = path.join(root, 'workspace');
        const pluginRoot = path.join(workspaceRoot, 'packages/plugin');
        const cacheDirectory = path.join(root, 'custom-hermes-cache');
        fs.mkdirSync(pluginRoot, { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
        process.env.STATIC_HERMES_CACHE_DIR = cacheDirectory;
        configureToolchain({ STATIC_HERMES_CACHE_DIR: cacheDirectory });

        await buildComponent({ ...buildOptions(), workspaceRoot: pluginRoot });

        expect(mocks.setupToolchain.mock.calls[0]?.[0]).toMatchObject({
            workspaceRoot,
            env: expect.objectContaining({ STATIC_HERMES_CACHE_DIR: cacheDirectory }),
        });
        expect(mocks.prepareHermes.mock.calls[0]?.[0]).toMatchObject({
            workspaceRoot,
            environment: expect.objectContaining({ STATIC_HERMES_CACHE_DIR: cacheDirectory }),
        });
    });

    it('sets up wasm-tools before analysis and prepares Hermes after analysis on a fresh build', async () => {
        const toolchain = configureToolchain({ WASM_TOOLS: '/toolchain/wasm-tools' });
        const stages: string[] = [];
        mocks.setupToolchain.mockImplementation(async () => {
            stages.push('setup');
            return toolchain;
        });
        mocks.analyze.mockImplementation(() => {
            expect(process.env.WASM_TOOLS).toBe('/toolchain/wasm-tools');
            stages.push('analyze');
            return { analysis: {} } as ComponentWitAnalysis;
        });
        mocks.prepareHermes.mockImplementation(async () => {
            stages.push('prepare');
        });
        expect(process.env.WASM_TOOLS).toBeUndefined();

        await buildComponent(buildOptions());

        expect(stages).toEqual(['setup', 'analyze', 'prepare']);
    });

    it('uses explicit full profile and stack size while skipping already-prepared Hermes', async () => {
        configureToolchain();
        process.env.PUMPKIN_PLUGINS_STATIC_HERMES_PREPARED = '1';
        process.env.STATIC_HERMES_STACK_SIZE = '524288';
        const options = { ...buildOptions(), runtimeVariant: 'full' as const };

        await buildComponent(options);

        expect(mocks.prepareHermes).not.toHaveBeenCalled();
        expect(mocks.compile).toHaveBeenCalledWith(
            expect.objectContaining({
                options: expect.objectContaining({
                    output: expect.stringContaining(path.join(outputDirectory, '.static-hermes-')),
                }),
                stackSizeBytes: '524288',
                toolchain: expect.objectContaining({
                    hermesRuntimeArchive: path.join(root, 'wasi-build/lib/libhermesvm_a.a'),
                }),
            }),
        );
    });

    it('prepares and links malloc when the shared build already prepared Hades', async () => {
        const toolchain = configureToolchain();
        process.env.PUMPKIN_PLUGINS_STATIC_HERMES_PREPARED = '1';
        const mallocBuild = `${toolchain.STATIC_HERMES_WASI_BUILD_DIR}-malloc`;
        mocks.prepareHermes.mockImplementation(async ({ gcVariant }: { gcVariant?: string }) => {
            expect(gcVariant).toBe('malloc');
            for (const artifact of ['lib/libhermesvm_a.a', 'lib/libhermesvmlean_a.a', 'jsi/libjsi.a']) {
                const filename = path.join(mallocBuild, artifact);
                fs.mkdirSync(path.dirname(filename), { recursive: true });
                fs.writeFileSync(filename, 'malloc archive');
            }
        });

        await buildComponent({ ...buildOptions(), gcVariant: 'malloc' });

        expect(mocks.prepareHermes).toHaveBeenCalledOnce();
        expect(mocks.compile).toHaveBeenCalledWith(
            expect.objectContaining({
                toolchain: expect.objectContaining({
                    hermesRuntimeArchive: path.join(mallocBuild, 'lib/libhermesvmlean_a.a'),
                }),
            }),
        );
    });

    it('rejects an invalid runtime profile before setting up the toolchain', async () => {
        const options = { ...buildOptions(), runtimeVariant: 'invalid' as 'lean' };

        await expect(buildComponent(options)).rejects.toThrow('--runtime-variant must be "full" or "lean"');

        expect(mocks.setupToolchain).not.toHaveBeenCalled();
        expect(mocks.prepareHermes).not.toHaveBeenCalled();
    });

    it('rejects invalid stack sizes before generating files', async () => {
        configureToolchain();
        process.env.STATIC_HERMES_STACK_SIZE = '131073';

        await expect(buildComponent(buildOptions())).rejects.toThrow(
            'STATIC_HERMES_STACK_SIZE must be a multiple of 16 and between 131072 and 4294967280 bytes',
        );
        expect(mocks.setupToolchain).not.toHaveBeenCalled();
        expect(mocks.prepareHermes).not.toHaveBeenCalled();
        expect(mocks.generate).not.toHaveBeenCalled();
        expect(mocks.compile).not.toHaveBeenCalled();
        expect(fs.readdirSync(outputDirectory)).toEqual([]);
    });

    it('rejects a stack larger than the wasm32 address space before setting up the toolchain', async () => {
        process.env.STATIC_HERMES_STACK_SIZE = '4294967296';

        await expect(buildComponent(buildOptions())).rejects.toThrow(
            'STATIC_HERMES_STACK_SIZE must be a multiple of 16 and between 131072 and 4294967280 bytes',
        );

        expect(mocks.setupToolchain).not.toHaveBeenCalled();
        expect(mocks.prepareHermes).not.toHaveBeenCalled();
    });

    it('rejects a missing plugin WIT file before setting up the toolchain', async () => {
        const options = buildOptions();
        configureToolchain();
        fs.rmSync(path.join(options.wit, 'plugin.wit'));

        await expect(buildComponent(options)).rejects.toThrow('Prepared WIT package has no plugin.wit');

        expect(mocks.setupToolchain).not.toHaveBeenCalled();
        expect(mocks.analyze).not.toHaveBeenCalled();
        expect(mocks.prepareHermes).not.toHaveBeenCalled();
    });

    it('rejects a missing bundle before setting up the toolchain', async () => {
        const options = buildOptions();
        configureToolchain();
        fs.rmSync(options.bundle);

        await expect(buildComponent(options)).rejects.toThrow(/ENOENT/);

        expect(mocks.setupToolchain).not.toHaveBeenCalled();
        expect(mocks.analyze).not.toHaveBeenCalled();
    });

    it('reports missing pinned artifacts before starting the component build', async () => {
        configureToolchain();
        fs.rmSync(path.join(root, 'wasi-build/lib/libhermesvmlean_a.a'));

        await expect(buildComponent(buildOptions())).rejects.toThrow('WASI Hermes lean runtime archive');
        expect(mocks.generate).not.toHaveBeenCalled();
        expect(mocks.compile).not.toHaveBeenCalled();
    });
});

function configureToolchain(extra: Record<string, string> = {}): Record<string, string> {
    const source = path.join(root, 'source');
    const hostBuild = path.join(root, 'host-build');
    const wasiBuild = path.join(root, 'wasi-build');
    const wasiSdk = path.join(root, 'wasi-sdk');
    const hermesc = path.join(hostBuild, 'bin/hermesc');
    fs.mkdirSync(source);
    fs.mkdirSync(path.dirname(hermesc), { recursive: true });
    fs.mkdirSync(path.join(wasiBuild, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(wasiBuild, 'jsi'), { recursive: true });
    fs.mkdirSync(path.join(wasiSdk, 'bin'), { recursive: true });
    fs.writeFileSync(hermesc, '');
    fs.writeFileSync(path.join(wasiBuild, 'lib/libhermesvmlean_a.a'), '');
    fs.writeFileSync(path.join(wasiBuild, 'lib/libhermesvm_a.a'), '');
    fs.writeFileSync(path.join(wasiBuild, 'jsi/libjsi.a'), '');
    const bindgen = path.join(root, 'wit-bindgen');
    fs.writeFileSync(bindgen, '');
    const toolchain = {
        STATIC_HERMES_CACHE_DIR: path.join(root, 'cache'),
        STATIC_HERMES_SOURCE_DIR: source,
        STATIC_HERMES_HOST_BUILD_DIR: hostBuild,
        STATIC_HERMES_WASI_BUILD_DIR: wasiBuild,
        STATIC_HERMES_WASI_SDK_PATH: wasiSdk,
        WIT_BINDGEN: bindgen,
        ...extra,
    };
    mocks.setupToolchain.mockResolvedValue(toolchain);
    return toolchain;
}

function buildOptions() {
    const wit = path.join(root, 'wit');
    const bundle = path.join(root, 'bundle.js');
    fs.mkdirSync(wit, { recursive: true });
    fs.writeFileSync(path.join(wit, 'plugin.wit'), 'package test:plugin; world plugin {}');
    fs.writeFileSync(bundle, '');
    return {
        bundle,
        wit,
        output: path.join(outputDirectory, 'plugin.wasm'),
        developmentMode: false,
        wasiImports: [],
    };
}
