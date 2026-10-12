import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentWitAnalysis } from './analyze.ts';
import { buildStaticHermesComponent } from './build.ts';
import type { ComponentGeneratedFiles } from './generate.ts';

const mocks = vi.hoisted(() => ({
    setupToolchain: vi.fn(),
    prepareHermes: vi.fn(),
    analyze: vi.fn(),
    generate: vi.fn(),
    compile: vi.fn()
}));

vi.mock('../hermes/toolchain-environment.ts', () => ({
    setupHermesToolchainEnvironment: mocks.setupToolchain
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
    'WIT_BINDGEN'
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
    mocks.compile.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    for (const [key, value] of originalEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

describe('buildStaticHermesComponent', () => {
    it('prepares missing Hermes artifacts, defaults to lean, and cleans temporary files', async () => {
        configureToolchain();

        await buildStaticHermesComponent(buildOptions());

        expect(mocks.setupToolchain).toHaveBeenCalledWith(
            expect.objectContaining({ includeWasiSdk: true, includeWitBindgen: true, includeWasmTools: true })
        );
        expect(mocks.prepareHermes).toHaveBeenCalledOnce();
        expect(mocks.analyze).toHaveBeenCalledWith(buildOptions());
        expect(mocks.compile).toHaveBeenCalledWith(
            expect.objectContaining({
                options: buildOptions(),
                stackSizeBytes: '262144',
                toolchain: expect.objectContaining({
                    hermesRuntimeArchive: path.join(root, 'wasi-build/lib/libhermesvmlean_a.a')
                })
            })
        );
        expect(fs.readdirSync(outputDirectory)).toEqual([]);
    });

    it('uses explicit full profile and stack size while skipping already-prepared Hermes', async () => {
        configureToolchain({
            PUMPKIN_PLUGINS_STATIC_HERMES_PREPARED: '1',
            STATIC_HERMES_STACK_SIZE: '524288'
        });
        const options = { ...buildOptions(), runtimeVariant: 'full' as const };

        await buildStaticHermesComponent(options);

        expect(mocks.prepareHermes).not.toHaveBeenCalled();
        expect(mocks.compile).toHaveBeenCalledWith(
            expect.objectContaining({
                options,
                stackSizeBytes: '524288',
                toolchain: expect.objectContaining({
                    hermesRuntimeArchive: path.join(root, 'wasi-build/lib/libhermesvm_a.a')
                })
            })
        );
    });

    it('rejects invalid stack sizes before generating files', async () => {
        configureToolchain({ STATIC_HERMES_STACK_SIZE: '131073' });

        await expect(buildStaticHermesComponent(buildOptions())).rejects.toThrow(
            'STATIC_HERMES_STACK_SIZE must be a multiple of 16 and at least 131072 bytes'
        );
        expect(mocks.generate).not.toHaveBeenCalled();
        expect(mocks.compile).not.toHaveBeenCalled();
        expect(fs.readdirSync(outputDirectory)).toEqual([]);
    });

    it('reports missing pinned artifacts before starting the component build', async () => {
        configureToolchain();
        fs.rmSync(path.join(root, 'wasi-build/lib/libhermesvmlean_a.a'));

        await expect(buildStaticHermesComponent(buildOptions())).rejects.toThrow('WASI Hermes lean runtime archive');
        expect(mocks.generate).not.toHaveBeenCalled();
        expect(mocks.compile).not.toHaveBeenCalled();
    });
});

function configureToolchain(extra: Record<string, string> = {}): void {
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
    mocks.setupToolchain.mockResolvedValue({
        STATIC_HERMES_CACHE_DIR: path.join(root, 'cache'),
        STATIC_HERMES_SOURCE_DIR: source,
        STATIC_HERMES_HOST_BUILD_DIR: hostBuild,
        STATIC_HERMES_WASI_BUILD_DIR: wasiBuild,
        STATIC_HERMES_WASI_SDK_PATH: wasiSdk,
        WIT_BINDGEN: bindgen,
        ...extra
    });
}

function buildOptions() {
    return {
        bundle: path.join(root, 'bundle.js'),
        wit: path.join(root, 'wit'),
        output: path.join(outputDirectory, 'plugin.wasm'),
        developmentMode: false,
        wasiImports: []
    };
}
