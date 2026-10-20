import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withHermesBuildLock } from './build.ts';
import {
    fetchWasiSdkRelease,
    type HermesToolchainSetupOptions,
    prepareStaticHermesBuild,
    publishWasiSdkDirectory,
    selectWasiSdkAsset,
    selectWasmToolsAsset,
    setupHermesToolchainEnvironment,
    verifyWasiSdkArchiveChecksum,
} from './toolchain-environment.ts';
import {
    configuredExecutablePath,
    executablePath,
    findExecutable,
    hermesHostCompilerPath,
    wasiSdkCompilerPath,
} from './toolchain-paths.ts';

const mocks = vi.hoisted(() => ({ execFileSync: vi.fn() }));

vi.mock('node:child_process', () => ({ execFileSync: mocks.execFileSync }));

// A block body keeps Vitest from calling the returned mock as a cleanup hook.
beforeEach(() => {
    mocks.execFileSync.mockReturnValue('wit-bindgen-cli 0.62.0 (test)');
});

const readJson = (file: string) => JSON.parse(fs.readFileSync(new URL(file, import.meta.url), 'utf8'));
const wasiSdkLock = readJson('../../wasi-sdk.lock.json');
const wasmToolsLock = readJson('../../wasm-tools.lock.json');
const { tools } = readJson('../../toolchain-versions.json');
const wasiSdkDirectory = `wasi-sdk-${wasiSdkLock.version}`;
const witBindgenDirectory = `wit-bindgen-${tools['wit-bindgen']}`;
const temporaryDirs: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    temporaryDirs.push(directory);
    return directory;
}

function writeWasiSdk(directory: string, platform: NodeJS.Platform = process.platform): void {
    fs.mkdirSync(path.join(directory, 'bin'), { recursive: true });
    fs.writeFileSync(wasiSdkCompilerPath(directory, 'wasm32-wasip2-clang', platform), '');
    fs.writeFileSync(wasiSdkCompilerPath(directory, 'wasm32-wasip2-clang++', platform), '');
}

/** Create a file, with its parent directories, for a tool the mocked `execFileSync` stands in for. */
function writeFixture(file: string, contents = ''): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
}

it('loads the package pins and resolves only the requested workspace cache', async () => {
    const workspaceRoot = path.resolve('/tmp/static-hermes-toolchain-test');

    const environment = await setupHermesToolchainEnvironment({
        workspaceRoot,
        env: {},
        includeWasiSdk: false,
        includeWitBindgen: false,
        includeWasmTools: false,
    });

    expect(environment).toEqual({ STATIC_HERMES_CACHE_DIR: path.join(workspaceRoot, '.cache/hermes') });
});

it('rejects a configured WASI SDK that is missing the target C++ compiler', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wasi-sdk-missing-cpp-'));
    const sdk = path.join(root, 'wasi-sdk');
    const cCompiler = wasiSdkCompilerPath(sdk, 'wasm32-wasip2-clang');
    const cppCompiler = process.platform === 'win32' ? 'wasm32-wasip2-clang++.exe' : 'wasm32-wasip2-clang++';
    fs.mkdirSync(path.dirname(cCompiler), { recursive: true });
    fs.writeFileSync(cCompiler, '');
    const installWasiSdk = vi.fn();

    try {
        await expect(
            setupHermesToolchainEnvironment({
                workspaceRoot: root,
                env: { STATIC_HERMES_WASI_SDK_PATH: sdk },
                installWasiSdk,
                includeWitBindgen: false,
                includeWasmTools: false,
            }),
        ).rejects.toThrow(`configured WASI SDK is missing bin/${cppCompiler}: ${sdk}`);
        expect(fs.existsSync(cCompiler)).toBe(true);
        expect(installWasiSdk).not.toHaveBeenCalled();
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

it('replaces an incomplete cached WASI SDK before installing the pinned SDK', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wasi-sdk-cache-recovery-'));
    const destination = path.join(root, '.cache', 'hermes', 'toolchain', 'wasi-sdk-34');
    fs.mkdirSync(path.join(destination, 'bin'), { recursive: true });
    fs.writeFileSync(wasiSdkCompilerPath(destination, 'wasm32-wasip2-clang'), 'incomplete cache');
    const installWasiSdk: NonNullable<HermesToolchainSetupOptions['installWasiSdk']> = async ({ destination }) => {
        expect(fs.existsSync(destination)).toBe(false);
        writeWasiSdk(destination);
        return destination;
    };

    try {
        const environment = await setupHermesToolchainEnvironment({
            workspaceRoot: root,
            env: {},
            includeWitBindgen: false,
            includeWasmTools: false,
            installWasiSdk,
        });

        expect(environment.STATIC_HERMES_WASI_SDK_PATH).toBe(destination);
        expect(fs.existsSync(wasiSdkCompilerPath(destination, 'wasm32-wasip2-clang++'))).toBe(true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

it('shares one WASI SDK installation between concurrent toolchain setups', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wasi-sdk-concurrent-'));
    const destination = path.join(root, '.cache', 'hermes', 'toolchain', 'wasi-sdk-34');
    let installCalls = 0;
    const installWasiSdk: NonNullable<HermesToolchainSetupOptions['installWasiSdk']> = async ({ destination }) => {
        installCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        writeWasiSdk(destination);
        return destination;
    };
    const options: HermesToolchainSetupOptions = {
        workspaceRoot: root,
        env: {},
        includeWitBindgen: false,
        includeWasmTools: false,
        installWasiSdk,
    };

    try {
        const environments = await Promise.all([
            setupHermesToolchainEnvironment(options),
            setupHermesToolchainEnvironment(options),
        ]);

        expect(installCalls).toBe(1);
        expect(environments.map(({ STATIC_HERMES_WASI_SDK_PATH }) => STATIC_HERMES_WASI_SDK_PATH)).toEqual([
            destination,
            destination,
        ]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

it('reuses cached tools while another process holds the Hermes build lock', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-toolchain-during-build-'));
    const cacheRoot = path.join(root, '.cache', 'hermes');
    const toolchainRoot = path.join(cacheRoot, 'toolchain');
    const wasiSdk = path.join(toolchainRoot, wasiSdkDirectory);
    const bindgen = executablePath(path.join(toolchainRoot, witBindgenDirectory, 'bin'), 'wit-bindgen');
    const wasmTools = executablePath(
        path.join(toolchainRoot, `wasm-tools-${tools['wasm-tools']}`, 'bin'),
        'wasm-tools',
    );
    writeWasiSdk(wasiSdk);
    for (const executable of [bindgen, wasmTools]) {
        fs.mkdirSync(path.dirname(executable), { recursive: true });
        fs.writeFileSync(executable, '');
    }
    mocks.execFileSync.mockImplementation((executable: string) =>
        executable === bindgen
            ? `wit-bindgen-cli ${tools['wit-bindgen']} (test)`
            : `wasm-tools ${tools['wasm-tools']} (test)`,
    );

    try {
        const environment = await withHermesBuildLock(cacheRoot, () =>
            setupHermesToolchainEnvironment({
                workspaceRoot: root,
                homeDirectory: root,
                env: {},
                includeWasmTools: true,
            }),
        );

        expect(environment).toMatchObject({
            STATIC_HERMES_WASI_SDK_PATH: wasiSdk,
            WIT_BINDGEN: bindgen,
            WASM_TOOLS: wasmTools,
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

it('rejects a configured wit-bindgen with a version different from the pin', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wit-bindgen-version-'));
    const bindgen = path.join(root, 'wit-bindgen');
    fs.writeFileSync(bindgen, '');
    mocks.execFileSync.mockReturnValue('wit-bindgen-cli 0.61.0 (test)');

    try {
        await expect(
            setupHermesToolchainEnvironment({
                workspaceRoot: root,
                env: { WIT_BINDGEN: bindgen },
                includeWasiSdk: false,
                includeWasmTools: false,
            }),
        ).rejects.toThrow('configured wit-bindgen must be wit-bindgen-cli 0.62.0: wit-bindgen-cli 0.61.0 (test)');
        expect(mocks.execFileSync).toHaveBeenCalledWith(bindgen, ['--version'], { encoding: 'utf8' });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

it('uses the configured WASI SDK and wit-bindgen paths when provided', async () => {
    const workspaceRoot = temporaryDirectory('static-hermes-existing-tools-');
    const wasiSdk = path.join(workspaceRoot, 'wasi-sdk');
    const witBindgen = path.join(workspaceRoot, 'bin', 'wit-bindgen');
    writeWasiSdk(wasiSdk);
    writeFixture(witBindgen);
    const installWasiSdk = vi.fn();
    const installWitBindgen = vi.fn();

    const environment = await setupHermesToolchainEnvironment({
        workspaceRoot,
        env: { WASI_SDK_PATH: wasiSdk, WIT_BINDGEN: witBindgen },
        installWasiSdk,
        installWitBindgen,
    });

    expect(environment).toEqual({
        STATIC_HERMES_CACHE_DIR: path.join(workspaceRoot, '.cache', 'hermes'),
        STATIC_HERMES_WASI_SDK_PATH: wasiSdk,
        WIT_BINDGEN: witBindgen,
    });
    expect(mocks.execFileSync).toHaveBeenCalledWith(witBindgen, ['--version'], { encoding: 'utf8' });
    expect(installWasiSdk).not.toHaveBeenCalled();
    expect(installWitBindgen).not.toHaveBeenCalled();
});

it('reinstalls a cached wit-bindgen when its version differs from the cache pin', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wit-bindgen-cache-'));
    const bindgen = path.join(root, '.cache/hermes/toolchain/wit-bindgen-0.62.0/bin/wit-bindgen');
    fs.mkdirSync(path.dirname(bindgen), { recursive: true });
    fs.writeFileSync(bindgen, 'old binary');
    mocks.execFileSync
        .mockReset()
        .mockImplementation((executable: string) =>
            fs.readFileSync(executable, 'utf8') === 'old binary'
                ? 'wit-bindgen-cli 0.61.0 (test)'
                : 'wit-bindgen-cli 0.62.0 (test)',
        );
    const installWitBindgen = vi.fn<NonNullable<HermesToolchainSetupOptions['installWitBindgen']>>(
        async ({ destination }) => {
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.writeFileSync(destination, 'new binary');
            return destination;
        },
    );

    try {
        const environment = await setupHermesToolchainEnvironment({
            workspaceRoot: root,
            env: {},
            homeDirectory: root,
            includeWasiSdk: false,
            includeWasmTools: false,
            installWitBindgen,
        });

        expect(environment.WIT_BINDGEN).toBe(bindgen);
        expect(fs.readFileSync(bindgen, 'utf8')).toBe('new binary');
        expect(installWitBindgen).toHaveBeenCalledOnce();
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

it('reinstalls cached wasm-tools when its version differs from the cache pin', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wasm-tools-cache-'));
    const wasmTools = path.join(root, '.cache/hermes/toolchain/wasm-tools-1.261.0/bin/wasm-tools');
    fs.mkdirSync(path.dirname(wasmTools), { recursive: true });
    fs.writeFileSync(wasmTools, 'old binary');
    mocks.execFileSync
        .mockReset()
        .mockImplementation((executable: string) =>
            fs.readFileSync(executable, 'utf8') === 'old binary'
                ? 'wasm-tools 1.0.0 (test)'
                : 'wasm-tools 1.261.0 (test)',
        );
    let installCalls = 0;
    const installWasmTools: NonNullable<HermesToolchainSetupOptions['installWasmTools']> = async ({ destination }) => {
        installCalls += 1;
        expect(fs.existsSync(destination)).toBe(false);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, 'new binary');
        return destination;
    };

    try {
        const environment = await setupHermesToolchainEnvironment({
            workspaceRoot: root,
            env: {},
            includeWasiSdk: false,
            includeWitBindgen: false,
            includeWasmTools: true,
            installWasmTools,
        });

        expect(environment.WASM_TOOLS).toBe(wasmTools);
        expect(fs.readFileSync(wasmTools, 'utf8')).toBe('new binary');
        expect(installCalls).toBe(1);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

it('reinstalls cached wasm-tools when the cached executable cannot run', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wasm-tools-corrupt-'));
    const wasmTools = path.join(root, '.cache/hermes/toolchain/wasm-tools-1.261.0/bin/wasm-tools');
    fs.mkdirSync(path.dirname(wasmTools), { recursive: true });
    fs.writeFileSync(wasmTools, 'corrupt binary');
    mocks.execFileSync.mockReset().mockImplementation((executable: string) => {
        if (fs.readFileSync(executable, 'utf8') === 'corrupt binary') throw new Error('not an executable');
        return 'wasm-tools 1.261.0 (test)';
    });
    let installCalls = 0;
    const installWasmTools: NonNullable<HermesToolchainSetupOptions['installWasmTools']> = async ({ destination }) => {
        installCalls += 1;
        expect(fs.existsSync(destination)).toBe(false);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, 'new binary');
        return destination;
    };

    try {
        const environment = await setupHermesToolchainEnvironment({
            workspaceRoot: root,
            env: {},
            includeWasiSdk: false,
            includeWitBindgen: false,
            includeWasmTools: true,
            installWasmTools,
        });

        expect(environment.WASM_TOOLS).toBe(wasmTools);
        expect(fs.readFileSync(wasmTools, 'utf8')).toBe('new binary');
        expect(installCalls).toBe(1);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

it('preserves a valid wasm-tools cache installed by a concurrent setup call', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wasm-tools-concurrent-'));
    const wasmTools = path.join(root, '.cache/hermes/toolchain/wasm-tools-1.261.0/bin/wasm-tools');
    mocks.execFileSync.mockReset().mockReturnValue('wasm-tools 1.261.0 (test)');
    let releaseInstall: (() => void) | undefined;
    let notifyInstallStarted: (() => void) | undefined;
    const installGate = new Promise<void>((resolve) => {
        releaseInstall = resolve;
    });
    const installStarted = new Promise<void>((resolve) => {
        notifyInstallStarted = resolve;
    });
    let installCalls = 0;
    const installWasmTools: NonNullable<HermesToolchainSetupOptions['installWasmTools']> = async ({ destination }) => {
        installCalls += 1;
        notifyInstallStarted?.();
        await installGate;
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, 'valid binary');
        return destination;
    };
    const setup = () =>
        setupHermesToolchainEnvironment({
            workspaceRoot: root,
            env: {},
            includeWasiSdk: false,
            includeWitBindgen: false,
            includeWasmTools: true,
            installWasmTools,
        });

    try {
        const first = setup();
        await installStarted;
        const second = setup();
        releaseInstall?.();
        const environments = await Promise.all([first, second]);

        expect(installCalls).toBe(1);
        expect(environments.map(({ WASM_TOOLS }) => WASM_TOOLS)).toEqual([wasmTools, wasmTools]);
        expect(fs.readFileSync(wasmTools, 'utf8')).toBe('valid binary');
    } finally {
        releaseInstall?.();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

it('installs a missing cached wit-bindgen only once for concurrent setup calls', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wit-bindgen-concurrent-'));
    let releaseInstall: (() => void) | undefined;
    const installGate = new Promise<void>((resolve) => {
        releaseInstall = resolve;
    });
    let installCalls = 0;
    const installWitBindgen: NonNullable<HermesToolchainSetupOptions['installWitBindgen']> = async ({
        destination,
    }) => {
        installCalls += 1;
        await installGate;
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, '');
        return destination;
    };

    try {
        const first = setupHermesToolchainEnvironment({
            workspaceRoot: root,
            env: {},
            homeDirectory: root,
            includeWasiSdk: false,
            includeWasmTools: false,
            installWitBindgen,
        });
        const second = setupHermesToolchainEnvironment({
            workspaceRoot: root,
            env: {},
            homeDirectory: root,
            includeWasiSdk: false,
            includeWasmTools: false,
            installWitBindgen,
        });

        await new Promise((resolve) => setTimeout(resolve, 0));
        releaseInstall?.();
        const environments = await Promise.all([first, second]);

        expect(installCalls).toBe(1);
        expect(environments[0]?.WIT_BINDGEN).toBe(environments[1]?.WIT_BINDGEN);
    } finally {
        releaseInstall?.();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

it('removes a partial wit-bindgen cache and retries the next setup', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wit-bindgen-partial-'));
    const bindgen = path.join(root, '.cache/hermes/toolchain/wit-bindgen-0.62.0/bin/wit-bindgen');
    let installCalls = 0;
    const installWitBindgen: NonNullable<HermesToolchainSetupOptions['installWitBindgen']> = async ({
        destination,
    }) => {
        installCalls += 1;
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, installCalls === 1 ? 'partial binary' : 'complete binary');
        if (installCalls === 1) throw new Error('cargo install failed');
        return destination;
    };

    try {
        await expect(
            setupHermesToolchainEnvironment({
                workspaceRoot: root,
                env: {},
                homeDirectory: root,
                includeWasiSdk: false,
                includeWasmTools: false,
                installWitBindgen,
            }),
        ).rejects.toThrow('cargo install failed');

        expect(fs.existsSync(bindgen)).toBe(false);
        const environment = await setupHermesToolchainEnvironment({
            workspaceRoot: root,
            env: {},
            homeDirectory: root,
            includeWasiSdk: false,
            includeWasmTools: false,
            installWitBindgen,
        });

        expect(environment.WIT_BINDGEN).toBe(bindgen);
        expect(installCalls).toBe(2);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

it('installs the pinned wit-bindgen when ~/.cargo/bin has a different version', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wit-bindgen-user-'));
    const userBindgen = path.join(root, '.cargo/bin/wit-bindgen');
    const cachedBindgen = path.join(root, '.cache/hermes/toolchain/wit-bindgen-0.62.0/bin/wit-bindgen');
    fs.mkdirSync(path.dirname(userBindgen), { recursive: true });
    fs.writeFileSync(userBindgen, '');
    mocks.execFileSync.mockImplementation((executable: string) =>
        executable === userBindgen ? 'wit-bindgen-cli 0.61.0 (test)' : 'wit-bindgen-cli 0.62.0 (test)',
    );
    const installWitBindgen = vi.fn<NonNullable<HermesToolchainSetupOptions['installWitBindgen']>>(
        async ({ destination }) => {
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.writeFileSync(destination, '');
            return destination;
        },
    );

    try {
        const environment = await setupHermesToolchainEnvironment({
            workspaceRoot: root,
            homeDirectory: root,
            env: {},
            includeWasiSdk: false,
            includeWasmTools: false,
            installWitBindgen,
        });

        expect(environment.WIT_BINDGEN).toBe(cachedBindgen);
        expect(installWitBindgen).toHaveBeenCalledOnce();
        expect(fs.existsSync(userBindgen)).toBe(true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

it('resolves Windows WASI SDK and wit-bindgen executable names', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-windows-tools-'));
    const sdk = path.join(root, 'wasi-sdk');
    const cache = path.join(root, 'cache');
    const compiler = path.join(sdk, 'bin', 'wasm32-wasip2-clang.exe');
    const cppCompiler = path.join(sdk, 'bin', 'wasm32-wasip2-clang++.exe');
    const bindgen = path.join(cache, 'toolchain', 'wit-bindgen-0.62.0', 'bin', 'wit-bindgen.exe');
    fs.mkdirSync(path.dirname(compiler), { recursive: true });
    fs.mkdirSync(path.dirname(bindgen), { recursive: true });
    fs.writeFileSync(compiler, '');
    fs.writeFileSync(cppCompiler, '');
    fs.writeFileSync(bindgen, '');

    try {
        const environment = await setupHermesToolchainEnvironment({
            workspaceRoot: root,
            platform: 'win32',
            arch: 'x64',
            env: {
                STATIC_HERMES_CACHE_DIR: cache,
                STATIC_HERMES_WASI_SDK_PATH: sdk,
            },
            includeWasmTools: false,
            installWitBindgen: async () => {
                throw new Error('cached Windows wit-bindgen should be reused');
            },
        });

        expect(environment).toMatchObject({
            STATIC_HERMES_CACHE_DIR: cache,
            STATIC_HERMES_WASI_SDK_PATH: sdk,
            WIT_BINDGEN: bindgen,
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

it('adds Windows executable suffixes when resolving tool paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-windows-paths-'));
    const cargo = path.join(root, 'cargo.exe');
    fs.writeFileSync(cargo, '');

    try {
        expect(hermesHostCompilerPath(path.join(root, 'hermes-build'), 'win32')).toBe(
            path.join(root, 'hermes-build', 'bin', 'hermesc.exe'),
        );
        expect(executablePath(path.join(root, 'hermes-build', 'bin'), 'shermes', 'win32')).toBe(
            path.join(root, 'hermes-build', 'bin', 'shermes.exe'),
        );
        expect(wasiSdkCompilerPath(root, 'wasm32-wasip2-clang', 'win32')).toBe(
            path.join(root, 'bin', 'wasm32-wasip2-clang.exe'),
        );
        expect(wasiSdkCompilerPath(root, 'wasm32-wasip2-clang++', 'win32')).toBe(
            path.join(root, 'bin', 'wasm32-wasip2-clang++.exe'),
        );
        expect(configuredExecutablePath(path.join(root, 'wit-bindgen'), 'win32')).toBe(
            path.join(root, 'wit-bindgen.exe'),
        );
        expect(findExecutable('cargo', { PATH: root }, 'win32')).toBe(cargo);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

it('installs missing pinned toolchain dependencies under .cache/hermes', async () => {
    const workspaceRoot = temporaryDirectory('static-hermes-install-tools-');
    const installWasiSdk = vi.fn<NonNullable<HermesToolchainSetupOptions['installWasiSdk']>>(({ destination }) => {
        writeWasiSdk(destination, 'darwin');
        return destination;
    });
    const installWitBindgen = vi.fn<NonNullable<HermesToolchainSetupOptions['installWitBindgen']>>(
        ({ destination }) => {
            writeFixture(destination);
            return destination;
        },
    );

    const environment = await setupHermesToolchainEnvironment({
        workspaceRoot,
        env: {},
        platform: 'darwin',
        arch: 'arm64',
        homeDirectory: workspaceRoot,
        installWasiSdk,
        installWitBindgen,
    });

    expect(installWasiSdk).toHaveBeenCalledWith(
        expect.objectContaining({
            platform: 'darwin',
            arch: 'arm64',
            destination: path.join(workspaceRoot, '.cache', 'hermes', 'toolchain', wasiSdkDirectory),
        }),
    );
    expect(installWitBindgen).toHaveBeenCalledWith(
        expect.objectContaining({
            destination: path.join(
                workspaceRoot,
                '.cache',
                'hermes',
                'toolchain',
                witBindgenDirectory,
                'bin',
                'wit-bindgen',
            ),
        }),
    );
    expect(environment.STATIC_HERMES_WASI_SDK_PATH).toBe(
        path.join(workspaceRoot, '.cache', 'hermes', 'toolchain', wasiSdkDirectory),
    );
    expect(environment.WIT_BINDGEN).toBe(
        path.join(workspaceRoot, '.cache', 'hermes', 'toolchain', witBindgenDirectory, 'bin', 'wit-bindgen'),
    );
});

it('keeps an installed SDK when a later installer publishes to the same cache path', () => {
    const workspaceRoot = temporaryDirectory('static-hermes-sdk-publish-');
    const destination = path.join(workspaceRoot, '.cache', 'hermes', 'toolchain', wasiSdkDirectory);
    const firstExtraction = path.join(workspaceRoot, 'first-install');
    const laterExtraction = path.join(workspaceRoot, 'later-install');
    const compilerPath = wasiSdkCompilerPath(destination, 'wasm32-wasip2-clang');

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    writeFixture(wasiSdkCompilerPath(firstExtraction, 'wasm32-wasip2-clang'), 'first SDK');
    writeFixture(wasiSdkCompilerPath(firstExtraction, 'wasm32-wasip2-clang++'), 'first SDK C++');
    writeFixture(wasiSdkCompilerPath(laterExtraction, 'wasm32-wasip2-clang'), 'later SDK');
    writeFixture(wasiSdkCompilerPath(laterExtraction, 'wasm32-wasip2-clang++'), 'later SDK C++');

    expect(publishWasiSdkDirectory(firstExtraction, destination)).toBe(destination);
    expect(publishWasiSdkDirectory(laterExtraction, destination)).toBe(destination);
    expect(fs.readFileSync(compilerPath, 'utf8')).toBe('first SDK');
});

it('uses the configured WASI SDK version for the cache path and release lookup', async () => {
    const workspaceRoot = temporaryDirectory('static-hermes-configured-sdk-');
    const installWasiSdk = vi.fn<NonNullable<HermesToolchainSetupOptions['installWasiSdk']>>(({ destination }) => {
        writeWasiSdk(destination, 'linux');
        return destination;
    });

    await setupHermesToolchainEnvironment({
        workspaceRoot,
        env: {},
        platform: 'linux',
        arch: 'x64',
        homeDirectory: workspaceRoot,
        includeWitBindgen: false,
        wasiSdkConfig: {
            repository: 'https://github.com/WebAssembly/wasi-sdk',
            version: '35',
            checksums: { 'linux/x64': 'b'.repeat(64) },
        },
        installWasiSdk,
    });

    expect(installWasiSdk).toHaveBeenCalledWith(
        expect.objectContaining({
            version: '35',
            sha256: 'b'.repeat(64),
            destination: path.join(workspaceRoot, '.cache', 'hermes', 'toolchain', 'wasi-sdk-35'),
        }),
    );
});

it('uses the configured wit-bindgen version for its install cache', async () => {
    const workspaceRoot = temporaryDirectory('static-hermes-configured-bindgen-');
    const wasiSdk = path.join(workspaceRoot, 'wasi-sdk');
    writeWasiSdk(wasiSdk);
    mocks.execFileSync.mockReturnValue('wit-bindgen-cli 0.63.1 (test)');
    const installWitBindgen = vi.fn<NonNullable<HermesToolchainSetupOptions['installWitBindgen']>>(
        ({ destination }) => {
            writeFixture(destination);
            return destination;
        },
    );

    await setupHermesToolchainEnvironment({
        workspaceRoot,
        env: { STATIC_HERMES_WASI_SDK_PATH: wasiSdk },
        homeDirectory: workspaceRoot,
        toolchainConfig: { tools: { 'wit-bindgen': '0.63.1', rust: '2.0.0' } },
        installWitBindgen,
    });

    expect(installWitBindgen).toHaveBeenCalledWith(
        expect.objectContaining({
            version: '0.63.1',
            destination: path.join(
                workspaceRoot,
                '.cache',
                'hermes',
                'toolchain',
                'wit-bindgen-0.63.1',
                'bin',
                'wit-bindgen',
            ),
        }),
    );
});

it('loads SDK assets from the configured GitHub release metadata endpoint', async () => {
    const release = { tag_name: 'wasi-sdk-35', assets: [] };
    const fetchImpl = vi.fn<typeof fetch>(async () => ({ ok: true, json: async () => release }) as Response);

    await expect(
        fetchWasiSdkRelease({
            repository: 'https://github.com/WebAssembly/wasi-sdk',
            version: '35',
            token: 'gh-token',
            fetchImpl,
        }),
    ).resolves.toBe(release);
    expect(fetchImpl).toHaveBeenCalledWith(
        'https://api.github.com/repos/WebAssembly/wasi-sdk/releases/tags/wasi-sdk-35',
        expect.objectContaining({
            headers: expect.objectContaining({ Authorization: 'Bearer gh-token' }),
        }),
    );
});

it.each<[NodeJS.Platform, string, string]>([
    ['darwin', 'arm64', 'arm64-macos'],
    ['darwin', 'x64', 'x86_64-macos'],
    ['linux', 'arm64', 'arm64-linux'],
    ['linux', 'riscv64', 'riscv64-linux'],
    ['linux', 'x64', 'x86_64-linux'],
    ['win32', 'arm64', 'arm64-windows'],
    ['win32', 'x64', 'x86_64-windows'],
])('selects the pinned WASI SDK archive and checksum for %s/%s', (platform, arch, target) => {
    const { version } = wasiSdkLock;
    const name = `wasi-sdk-${version}.0-${target}.tar.gz`;
    const digest = wasiSdkLock.checksums[`${platform}/${arch}`];
    const release = {
        assets: [
            { name: `wasi-sdk-${version}.0-x86_64-linux.deb`, browser_download_url: 'https://example.invalid/deb' },
            {
                name,
                browser_download_url: `https://example.invalid/${name}`,
                digest: `sha256:${digest}`,
            },
        ],
    };

    expect(selectWasiSdkAsset(release, { version, platform, arch, expectedSha256: digest })).toEqual(
        expect.objectContaining({ name, digest: `sha256:${digest}` }),
    );
});

it('requires a checksum and a matching archive for the pinned WASI SDK release', () => {
    expect(() =>
        selectWasiSdkAsset(
            {
                assets: [
                    { name: 'wasi-sdk-34.0-x86_64-linux.tar.gz', browser_download_url: 'https://example.invalid' },
                ],
            },
            { version: '34', platform: 'linux', arch: 'x64', expectedSha256: 'a'.repeat(64) },
        ),
    ).toThrow(/SHA-256 digest/);
    expect(() =>
        selectWasiSdkAsset(
            { assets: [] },
            { version: '34', platform: 'freebsd', arch: 'x64', expectedSha256: 'a'.repeat(64) },
        ),
    ).toThrow(/no WASI SDK 34 archive for freebsd\/x64/);
});

it('rejects release metadata whose SDK checksum differs from the lock pin', () => {
    const release = {
        assets: [
            {
                name: 'wasi-sdk-34.0-x86_64-linux.tar.gz',
                browser_download_url: 'https://example.invalid/sdk.tar.gz',
                digest: `sha256:${'a'.repeat(64)}`,
            },
        ],
    };

    expect(() =>
        selectWasiSdkAsset(release, {
            version: '34',
            platform: 'linux',
            arch: 'x64',
            expectedSha256: 'b'.repeat(64),
        }),
    ).toThrow(/does not match the pinned SHA-256/);
});

it('verifies downloaded WASI SDK bytes against the lock checksum', async () => {
    const archive = path.join(temporaryDirectory('static-hermes-sdk-archive-checksum-'), 'sdk.tar.gz');
    const archiveBytes = Buffer.from([1, 2, 3]);
    const expectedSha256 = createHash('sha256').update(archiveBytes).digest('hex');
    fs.writeFileSync(archive, archiveBytes);

    await expect(verifyWasiSdkArchiveChecksum(archive, expectedSha256)).resolves.toBeUndefined();

    await expect(verifyWasiSdkArchiveChecksum(archive, '0'.repeat(64))).rejects.toThrow(/WASI SDK checksum mismatch/);
});

it.each<[NodeJS.Platform, string, string]>([
    ['darwin', 'arm64', 'aarch64-macos.tar.gz'],
    ['darwin', 'x64', 'x86_64-macos.tar.gz'],
    ['linux', 'arm64', 'aarch64-linux.tar.gz'],
    ['linux', 'x64', 'x86_64-linux.tar.gz'],
    ['win32', 'arm64', 'aarch64-windows.zip'],
    ['win32', 'x64', 'x86_64-windows.zip'],
])('pins the wasm-tools archive and checksum for %s/%s', (platform, arch, suffix) => {
    const version = tools['wasm-tools'];
    const name = `wasm-tools-${version}-${suffix}`;
    expect(selectWasmToolsAsset(wasmToolsLock, { version, platform, arch })).toEqual({
        name,
        url: `https://github.com/bytecodealliance/wasm-tools/releases/download/v${version}/${name}`,
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
});

it('fails clearly for a platform without a pinned wasm-tools binary', () => {
    const version = tools['wasm-tools'];
    expect(() => selectWasmToolsAsset(wasmToolsLock, { version, platform: 'freebsd', arch: 'x64' })).toThrow(
        `no pinned wasm-tools ${version} binary for freebsd/x64`,
    );
});

it('downloads the wasm-tools archive that the lock file pins for the configured version', async () => {
    const workspaceRoot = temporaryDirectory('static-hermes-wasm-tools-lock-');
    const name = 'wasm-tools-1.262.0-x86_64-linux.tar.gz';
    const fetchImpl = vi.fn<typeof fetch>(async () => ({ ok: false, status: 404 }) as Response);

    await expect(
        setupHermesToolchainEnvironment({
            workspaceRoot,
            env: {},
            platform: 'linux',
            arch: 'x64',
            includeWasiSdk: false,
            includeWitBindgen: false,
            includeWasmTools: true,
            toolchainConfig: { tools: { ...tools, 'wasm-tools': '1.262.0' } },
            wasmToolsLock: {
                repository: 'https://github.com/bytecodealliance/wasm-tools',
                assets: { 'linux/x64': { name, sha256: 'c'.repeat(64) } },
            },
            fetchImpl,
        }),
    ).rejects.toThrow(`Could not download ${name}: HTTP 404`);
    expect(fetchImpl).toHaveBeenCalledWith(
        `https://github.com/bytecodealliance/wasm-tools/releases/download/v1.262.0/${name}`,
    );
});

it('rejects a wasm-tools lock file whose assets belong to another version', async () => {
    const workspaceRoot = temporaryDirectory('static-hermes-wasm-tools-stale-lock-');
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
        setupHermesToolchainEnvironment({
            workspaceRoot,
            env: {},
            platform: 'linux',
            arch: 'x64',
            includeWasiSdk: false,
            includeWitBindgen: false,
            includeWasmTools: true,
            toolchainConfig: { tools: { ...tools, 'wasm-tools': '1.262.0' } },
            fetchImpl,
        }),
    ).rejects.toThrow(/wasm-tools\.lock\.json must pin wasm-tools 1\.262\.0/);
    expect(fetchImpl).not.toHaveBeenCalled();
});

it('rejects a configured wasm-tools executable with the wrong pinned version', async () => {
    const workspaceRoot = temporaryDirectory('static-hermes-wasm-tools-version-');
    const executable = path.join(workspaceRoot, 'wasm-tools');
    writeFixture(executable);
    mocks.execFileSync.mockReturnValue('wasm-tools 1.0.0 (test)');

    await expect(
        setupHermesToolchainEnvironment({
            workspaceRoot,
            env: { WASM_TOOLS: executable },
            includeWasiSdk: false,
            includeWitBindgen: false,
            includeWasmTools: true,
        }),
    ).rejects.toThrow(`configured wasm-tools must be wasm-tools ${tools['wasm-tools']}: wasm-tools 1.0.0 (test)`);
});

it('does not install a wasm-tools archive whose digest differs from the pinned release', async () => {
    const workspaceRoot = temporaryDirectory('static-hermes-wasm-tools-checksum-');
    const fetchImpl = vi.fn<typeof fetch>(
        async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) as Response,
    );

    await expect(
        setupHermesToolchainEnvironment({
            workspaceRoot,
            env: {},
            platform: 'linux',
            arch: 'x64',
            includeWasiSdk: false,
            includeWitBindgen: false,
            includeWasmTools: true,
            fetchImpl,
        }),
    ).rejects.toThrow(/wasm-tools checksum mismatch/);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fs.readdirSync(path.join(workspaceRoot, '.cache', 'hermes', 'toolchain'))).toEqual([]);
});

it('installs and exposes the pinned wasm-tools binary in the shared cache', async () => {
    const workspaceRoot = temporaryDirectory('static-hermes-wasm-tools-');
    const destination = path.join(
        workspaceRoot,
        '.cache',
        'hermes',
        'toolchain',
        `wasm-tools-${tools['wasm-tools']}`,
        'bin',
        'wasm-tools',
    );
    mocks.execFileSync.mockReturnValue(`wasm-tools ${tools['wasm-tools']} (test)`);
    const installWasmTools = vi.fn<NonNullable<HermesToolchainSetupOptions['installWasmTools']>>(
        ({ destination: executable }) => {
            writeFixture(executable);
            return executable;
        },
    );

    const environment = await setupHermesToolchainEnvironment({
        workspaceRoot,
        env: {},
        platform: 'darwin',
        arch: 'arm64',
        includeWasiSdk: false,
        includeWitBindgen: false,
        includeWasmTools: true,
        installWasmTools,
    });

    expect(installWasmTools).toHaveBeenCalledWith(
        expect.objectContaining({ version: tools['wasm-tools'], platform: 'darwin', arch: 'arm64', destination }),
    );
    expect(environment.WASM_TOOLS).toBe(destination);
});

it('prepares the selected Hermes toolchain before compiling a component', async () => {
    const env: NodeJS.ProcessEnv = {};
    const setupEnvironment = vi.fn(async () => ({
        STATIC_HERMES_WASI_SDK_PATH: '/sdk',
        WIT_BINDGEN: '/tools/wit-bindgen',
    }));
    const prepare = vi.fn(async () => {
        expect(env.STATIC_HERMES_WASI_SDK_PATH).toBe('/sdk');
        expect(env.WIT_BINDGEN).toBe('/tools/wit-bindgen');
    });

    await prepareStaticHermesBuild({
        workspaceRoot: '/workspace',
        env,
        setupEnvironment,
        prepare,
    });

    expect(setupEnvironment).toHaveBeenCalledWith({ workspaceRoot: '/workspace', env, includeWasmTools: true });
    expect(prepare).toHaveBeenCalledOnce();
});

it('skips repeated Hermes preparation when the workspace build already prepared it', async () => {
    const env: NodeJS.ProcessEnv = { PUMPKIN_PLUGINS_STATIC_HERMES_PREPARED: '1' };
    const setupEnvironment = vi.fn(async () => ({ STATIC_HERMES_WASI_SDK_PATH: '/sdk' }));
    const prepare = vi.fn();

    await prepareStaticHermesBuild({
        workspaceRoot: '/workspace',
        env,
        setupEnvironment,
        prepare,
    });

    expect(setupEnvironment).toHaveBeenCalledWith({ workspaceRoot: '/workspace', env, includeWasmTools: true });
    expect(prepare).not.toHaveBeenCalled();
});
