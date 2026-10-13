import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { setupHermesToolchainEnvironment } from './toolchain-environment.ts';
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

it('rejects a cached wit-bindgen when its version differs from the cache pin', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wit-bindgen-cache-'));
    const bindgen = path.join(root, '.cache/hermes/toolchain/wit-bindgen-0.62.0/bin/wit-bindgen');
    fs.mkdirSync(path.dirname(bindgen), { recursive: true });
    fs.writeFileSync(bindgen, '');
    mocks.execFileSync.mockReturnValue('wit-bindgen-cli 0.61.0 (test)');

    try {
        await expect(
            setupHermesToolchainEnvironment({
                workspaceRoot: root,
                env: {},
                includeWasiSdk: false,
                includeWasmTools: false
            })
        ).rejects.toThrow('cached wit-bindgen must be wit-bindgen-cli 0.62.0: wit-bindgen-cli 0.61.0 (test)');
        expect(mocks.execFileSync).toHaveBeenCalledWith(bindgen, ['--version'], { encoding: 'utf8' });
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
    const bindgen = path.join(cache, 'toolchain', 'wit-bindgen-0.62.0', 'bin', 'wit-bindgen.exe');
    fs.mkdirSync(path.dirname(compiler), { recursive: true });
    fs.mkdirSync(path.dirname(bindgen), { recursive: true });
    fs.writeFileSync(compiler, '');
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
