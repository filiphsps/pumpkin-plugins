import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
    fetchWasiSdkRelease,
    prepareStaticHermesBuild,
    selectWasiSdkAsset,
    setupHermesToolchainEnvironment
} from '../bin/toolchain-environment.mjs';

const temporaryDirs = [];

afterEach(() => {
    for (const directory of temporaryDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

it('uses the installed QuickJS WASI SDK and wit-bindgen paths when provided', async () => {
    const workspaceRoot = temporaryDirectory('static-hermes-existing-tools-');
    const wasiSdk = path.join(workspaceRoot, 'wasi-sdk');
    const witBindgen = path.join(workspaceRoot, 'bin', 'wit-bindgen');
    writeExecutable(path.join(wasiSdk, 'bin', 'wasm32-wasip2-clang'));
    writeExecutable(witBindgen);
    const installWasiSdk = vi.fn();
    const installWitBindgen = vi.fn();

    const environment = await setupHermesToolchainEnvironment({
        workspaceRoot,
        env: { WASI_SDK_PATH: wasiSdk, WIT_BINDGEN: witBindgen },
        installWasiSdk,
        installWitBindgen
    });

    expect(environment).toEqual({
        STATIC_HERMES_CACHE_DIR: path.join(workspaceRoot, '.cache', 'hermes'),
        STATIC_HERMES_WASI_SDK_PATH: wasiSdk,
        WIT_BINDGEN: witBindgen
    });
    expect(installWasiSdk).not.toHaveBeenCalled();
    expect(installWitBindgen).not.toHaveBeenCalled();
});

it('installs missing pinned toolchain dependencies under .cache/hermes', async () => {
    const workspaceRoot = temporaryDirectory('static-hermes-install-tools-');
    const installWasiSdk = vi.fn(({ destination }) => {
        writeExecutable(path.join(destination, 'bin', 'wasm32-wasip2-clang'));
        return destination;
    });
    const installWitBindgen = vi.fn(({ destination }) => {
        writeExecutable(destination);
        return destination;
    });

    const environment = await setupHermesToolchainEnvironment({
        workspaceRoot,
        env: {},
        platform: 'darwin',
        arch: 'arm64',
        homeDirectory: workspaceRoot,
        installWasiSdk,
        installWitBindgen
    });

    expect(installWasiSdk).toHaveBeenCalledWith(
        expect.objectContaining({
            platform: 'darwin',
            arch: 'arm64',
            destination: path.join(workspaceRoot, '.cache', 'hermes', 'toolchain', 'wasi-sdk-34')
        })
    );
    expect(installWitBindgen).toHaveBeenCalledWith(
        expect.objectContaining({
            destination: path.join(
                workspaceRoot,
                '.cache',
                'hermes',
                'toolchain',
                'wit-bindgen-0.62.0',
                'bin',
                'wit-bindgen'
            )
        })
    );
    expect(environment.STATIC_HERMES_WASI_SDK_PATH).toBe(
        path.join(workspaceRoot, '.cache', 'hermes', 'toolchain', 'wasi-sdk-34')
    );
    expect(environment.WIT_BINDGEN).toBe(
        path.join(workspaceRoot, '.cache', 'hermes', 'toolchain', 'wit-bindgen-0.62.0', 'bin', 'wit-bindgen')
    );
});

it('uses the configured WASI SDK version for the cache path and release lookup', async () => {
    const workspaceRoot = temporaryDirectory('static-hermes-configured-sdk-');
    const installWasiSdk = vi.fn(({ destination }) => {
        writeExecutable(path.join(destination, 'bin', 'wasm32-wasip2-clang'));
        return destination;
    });

    await setupHermesToolchainEnvironment({
        workspaceRoot,
        env: {},
        platform: 'linux',
        arch: 'x64',
        homeDirectory: workspaceRoot,
        includeWitBindgen: false,
        wasiSdkConfig: { repository: 'https://github.com/WebAssembly/wasi-sdk', version: '35' },
        installWasiSdk
    });

    expect(installWasiSdk).toHaveBeenCalledWith(
        expect.objectContaining({
            version: '35',
            destination: path.join(workspaceRoot, '.cache', 'hermes', 'toolchain', 'wasi-sdk-35')
        })
    );
});

it('uses the configured wit-bindgen version for its install cache', async () => {
    const workspaceRoot = temporaryDirectory('static-hermes-configured-bindgen-');
    const wasiSdk = path.join(workspaceRoot, 'wasi-sdk');
    writeExecutable(path.join(wasiSdk, 'bin', 'wasm32-wasip2-clang'));
    const installWitBindgen = vi.fn(({ destination }) => {
        writeExecutable(destination);
        return destination;
    });

    await setupHermesToolchainEnvironment({
        workspaceRoot,
        env: { STATIC_HERMES_WASI_SDK_PATH: wasiSdk },
        homeDirectory: workspaceRoot,
        toolchainConfig: { tools: { 'wit-bindgen': '0.63.1', rust: '2.0.0' } },
        installWitBindgen
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
                'wit-bindgen'
            )
        })
    );
});

it('loads SDK assets from the configured GitHub release metadata endpoint', async () => {
    const release = { tag_name: 'wasi-sdk-35', assets: [] };
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => release }));

    await expect(
        fetchWasiSdkRelease({
            repository: 'https://github.com/WebAssembly/wasi-sdk',
            version: '35',
            token: 'gh-token',
            fetchImpl
        })
    ).resolves.toBe(release);
    expect(fetchImpl).toHaveBeenCalledWith(
        'https://api.github.com/repos/WebAssembly/wasi-sdk/releases/tags/wasi-sdk-35',
        expect.objectContaining({
            headers: expect.objectContaining({ Authorization: 'Bearer gh-token' })
        })
    );
});

it.each([
    ['darwin', 'arm64', 'wasi-sdk-34.0-arm64-macos.tar.gz'],
    ['win32', 'arm64', 'wasi-sdk-34.0-arm64-windows.tar.gz'],
    ['linux', 'riscv64', 'wasi-sdk-34.0-riscv64-linux.tar.gz']
])('selects the matching WASI SDK archive from release assets for %s/%s', (platform, arch, name) => {
    const release = {
        assets: [
            { name: 'wasi-sdk-34.0-x86_64-linux.deb', browser_download_url: 'https://example.invalid/deb' },
            {
                name,
                browser_download_url: `https://example.invalid/${name}`,
                digest: `sha256:${'a'.repeat(64)}`
            }
        ]
    };

    expect(selectWasiSdkAsset(release, { version: '34', platform, arch })).toEqual(
        expect.objectContaining({ name, digest: `sha256:${'a'.repeat(64)}` })
    );
});

it('requires a checksum and a matching archive for the pinned WASI SDK release', () => {
    expect(() =>
        selectWasiSdkAsset(
            {
                assets: [{ name: 'wasi-sdk-34.0-x86_64-linux.tar.gz', browser_download_url: 'https://example.invalid' }]
            },
            { version: '34', platform: 'linux', arch: 'x64' }
        )
    ).toThrow(/SHA-256 digest/);
    expect(() => selectWasiSdkAsset({ assets: [] }, { version: '34', platform: 'freebsd', arch: 'x64' })).toThrow(
        /no WASI SDK 34 archive for freebsd\/x64/
    );
});

it('prepares the selected Hermes toolchain before compiling a component', async () => {
    const env = {};
    const setupEnvironment = vi.fn(async () => ({
        STATIC_HERMES_WASI_SDK_PATH: '/sdk',
        WIT_BINDGEN: '/tools/wit-bindgen'
    }));
    const prepare = vi.fn(async () => {
        expect(env.STATIC_HERMES_WASI_SDK_PATH).toBe('/sdk');
        expect(env.WIT_BINDGEN).toBe('/tools/wit-bindgen');
    });

    await prepareStaticHermesBuild({
        workspaceRoot: '/workspace',
        env,
        setupEnvironment,
        prepare
    });

    expect(setupEnvironment).toHaveBeenCalledWith({ workspaceRoot: '/workspace', env });
    expect(prepare).toHaveBeenCalledOnce();
});

function temporaryDirectory(prefix) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    temporaryDirs.push(directory);
    return directory;
}

function writeExecutable(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(file, 0o755);
}
