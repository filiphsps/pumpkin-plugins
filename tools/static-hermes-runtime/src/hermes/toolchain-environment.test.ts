import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { type HermesToolchainSetupOptions, setupHermesToolchainEnvironment } from './toolchain-environment.ts';
import {
    configuredExecutablePath,
    executablePath,
    findExecutable,
    hermesHostCompilerPath,
    wasiSdkCompilerPath
} from './toolchain-paths.ts';

const mocks = vi.hoisted(() => ({ execFileSync: vi.fn() }));

vi.mock('node:child_process', () => ({ execFileSync: mocks.execFileSync }));

beforeEach(() => mocks.execFileSync.mockReturnValue('wit-bindgen-cli 0.62.0 (test)'));

function writeWasiSdk(directory: string): void {
    fs.mkdirSync(path.join(directory, 'bin'), { recursive: true });
    fs.writeFileSync(wasiSdkCompilerPath(directory, 'wasm32-wasip2-clang'), '');
    fs.writeFileSync(wasiSdkCompilerPath(directory, 'wasm32-wasip2-clang++'), '');
}

it('loads the package pins and resolves only the requested workspace cache', async () => {
    const workspaceRoot = path.resolve('/tmp/static-hermes-toolchain-test');

    const environment = await setupHermesToolchainEnvironment({
        workspaceRoot,
        env: {},
        includeWasiSdk: false,
        includeWitBindgen: false,
        includeWasmTools: false
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
                includeWasmTools: false
            })
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
            installWasiSdk
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
        installWasiSdk
    };

    try {
        const environments = await Promise.all([
            setupHermesToolchainEnvironment(options),
            setupHermesToolchainEnvironment(options)
        ]);

        expect(installCalls).toBe(1);
        expect(environments.map(({ STATIC_HERMES_WASI_SDK_PATH }) => STATIC_HERMES_WASI_SDK_PATH)).toEqual([
            destination,
            destination
        ]);
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
                includeWasmTools: false
            })
        ).rejects.toThrow('configured wit-bindgen must be wit-bindgen-cli 0.62.0: wit-bindgen-cli 0.61.0 (test)');
        expect(mocks.execFileSync).toHaveBeenCalledWith(bindgen, ['--version'], { encoding: 'utf8' });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

it('accepts a configured wit-bindgen only when its version matches the pin', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wit-bindgen-version-'));
    const bindgen = path.join(root, 'wit-bindgen');
    fs.writeFileSync(bindgen, '');

    try {
        const environment = await setupHermesToolchainEnvironment({
            workspaceRoot: root,
            env: { WIT_BINDGEN: bindgen },
            includeWasiSdk: false,
            includeWasmTools: false
        });

        expect(environment.WIT_BINDGEN).toBe(bindgen);
        expect(mocks.execFileSync).toHaveBeenCalledWith(bindgen, ['--version'], { encoding: 'utf8' });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

it('reinstalls a cached wit-bindgen when its version differs from the cache pin', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wit-bindgen-cache-'));
    const bindgen = path.join(root, '.cache/hermes/toolchain/wit-bindgen-0.62.0/bin/wit-bindgen');
    fs.mkdirSync(path.dirname(bindgen), { recursive: true });
    fs.writeFileSync(bindgen, '');
    mocks.execFileSync
        .mockReset()
        .mockReturnValueOnce('wit-bindgen-cli 0.61.0 (test)')
        .mockReturnValue('wit-bindgen-cli 0.62.0 (test)');
    const installWitBindgen: NonNullable<HermesToolchainSetupOptions['installWitBindgen']> = async ({
        destination
    }) => {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, '');
        return destination;
    };

    try {
        const environment = await setupHermesToolchainEnvironment({
            workspaceRoot: root,
            env: {},
            homeDirectory: root,
            includeWasiSdk: false,
            includeWasmTools: false,
            installWitBindgen
        });

        expect(environment.WIT_BINDGEN).toBe(bindgen);
        expect(mocks.execFileSync).toHaveBeenCalledWith(bindgen, ['--version'], { encoding: 'utf8' });
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
        .mockReturnValueOnce('wasm-tools 1.0.0 (test)')
        .mockReturnValue('wasm-tools 1.261.0 (test)');
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
            installWasmTools
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
    mocks.execFileSync
        .mockReset()
        .mockImplementationOnce(() => {
            throw new Error('not an executable');
        })
        .mockReturnValue('wasm-tools 1.261.0 (test)');
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
            installWasmTools
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
            installWasmTools
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
        destination
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
            installWitBindgen
        });
        const second = setupHermesToolchainEnvironment({
            workspaceRoot: root,
            env: {},
            homeDirectory: root,
            includeWasiSdk: false,
            includeWasmTools: false,
            installWitBindgen
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
        destination
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
                installWitBindgen
            })
        ).rejects.toThrow('cargo install failed');

        expect(fs.existsSync(bindgen)).toBe(false);
        const environment = await setupHermesToolchainEnvironment({
            workspaceRoot: root,
            env: {},
            homeDirectory: root,
            includeWasiSdk: false,
            includeWasmTools: false,
            installWitBindgen
        });

        expect(environment.WIT_BINDGEN).toBe(bindgen);
        expect(installCalls).toBe(2);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

it('rejects a user-installed wit-bindgen when its version differs from the pin', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wit-bindgen-user-'));
    const bindgen = path.join(root, '.cargo/bin/wit-bindgen');
    fs.mkdirSync(path.dirname(bindgen), { recursive: true });
    fs.writeFileSync(bindgen, '');
    mocks.execFileSync.mockReturnValue('wit-bindgen-cli 0.61.0 (test)');

    try {
        await expect(
            setupHermesToolchainEnvironment({
                workspaceRoot: root,
                homeDirectory: root,
                env: {},
                includeWasiSdk: false,
                includeWasmTools: false
            })
        ).rejects.toThrow('user-installed wit-bindgen must be wit-bindgen-cli 0.62.0: wit-bindgen-cli 0.61.0 (test)');
        expect(mocks.execFileSync).toHaveBeenCalledWith(bindgen, ['--version'], { encoding: 'utf8' });
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
                STATIC_HERMES_WASI_SDK_PATH: sdk
            },
            includeWasmTools: false,
            installWitBindgen: async () => {
                throw new Error('cached Windows wit-bindgen should be reused');
            }
        });

        expect(environment).toMatchObject({
            STATIC_HERMES_CACHE_DIR: cache,
            STATIC_HERMES_WASI_SDK_PATH: sdk,
            WIT_BINDGEN: bindgen
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
            path.join(root, 'hermes-build', 'bin', 'hermesc.exe')
        );
        expect(executablePath(path.join(root, 'hermes-build', 'bin'), 'shermes', 'win32')).toBe(
            path.join(root, 'hermes-build', 'bin', 'shermes.exe')
        );
        expect(wasiSdkCompilerPath(root, 'wasm32-wasip2-clang', 'win32')).toBe(
            path.join(root, 'bin', 'wasm32-wasip2-clang.exe')
        );
        expect(wasiSdkCompilerPath(root, 'wasm32-wasip2-clang++', 'win32')).toBe(
            path.join(root, 'bin', 'wasm32-wasip2-clang++.exe')
        );
        expect(configuredExecutablePath(path.join(root, 'wit-bindgen'), 'win32')).toBe(
            path.join(root, 'wit-bindgen.exe')
        );
        expect(findExecutable('cargo', { PATH: root }, 'win32')).toBe(cargo);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
