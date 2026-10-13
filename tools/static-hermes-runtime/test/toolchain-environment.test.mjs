import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as toolchainEnvironment from '../src/hermes/toolchain-environment.ts';

const { fetchWasiSdkRelease, prepareStaticHermesBuild, selectWasiSdkAsset, setupHermesToolchainEnvironment } =
    toolchainEnvironment;
const { selectWasmToolsAsset } = toolchainEnvironment;
const wasiSdkLock = JSON.parse(fs.readFileSync(new URL('../wasi-sdk.lock.json', import.meta.url), 'utf8'));

const temporaryDirs = [];

afterEach(() => {
    for (const directory of temporaryDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

it('uses the installed QuickJS WASI SDK and wit-bindgen paths when provided', async () => {
    const workspaceRoot = temporaryDirectory('static-hermes-existing-tools-');
    const wasiSdk = path.join(workspaceRoot, 'wasi-sdk');
    const witBindgen = path.join(workspaceRoot, 'bin', 'wit-bindgen');
    writeExecutable(path.join(wasiSdk, 'bin', 'wasm32-wasip2-clang'));
    writeExecutable(path.join(wasiSdk, 'bin', 'wasm32-wasip2-clang++'));
    writeExecutable(witBindgen, '#!/bin/sh\necho "wit-bindgen-cli 0.62.0 (fixture)"\n');
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
        writeExecutable(path.join(destination, 'bin', 'wasm32-wasip2-clang++'));
        return destination;
    });
    const installWitBindgen = vi.fn(({ destination, version }) => {
        writeExecutable(destination, `#!/bin/sh\necho "wit-bindgen-cli ${version} (fixture)"\n`);
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

it('keeps an installed SDK when a later installer publishes to the same cache path', () => {
    const workspaceRoot = temporaryDirectory('static-hermes-sdk-publish-');
    const destination = path.join(workspaceRoot, '.cache', 'hermes', 'toolchain', 'wasi-sdk-34');
    const firstExtraction = path.join(workspaceRoot, 'first-install');
    const laterExtraction = path.join(workspaceRoot, 'later-install');
    const compilerPath = path.join(destination, 'bin', 'wasm32-wasip2-clang');

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    writeExecutable(path.join(firstExtraction, 'bin', 'wasm32-wasip2-clang'), '#!/bin/sh\n# first SDK\nexit 0\n');
    writeExecutable(path.join(firstExtraction, 'bin', 'wasm32-wasip2-clang++'), '#!/bin/sh\n# first SDK C++\nexit 0\n');
    writeExecutable(path.join(laterExtraction, 'bin', 'wasm32-wasip2-clang'), '#!/bin/sh\n# later SDK\nexit 0\n');
    writeExecutable(path.join(laterExtraction, 'bin', 'wasm32-wasip2-clang++'), '#!/bin/sh\n# later SDK C++\nexit 0\n');

    const publish = toolchainEnvironment.publishWasiSdkDirectory;
    const firstResult = publish?.(firstExtraction, destination);
    const laterResult = publish?.(laterExtraction, destination);

    expect(firstResult).toBe(destination);
    expect(laterResult).toBe(destination);
    expect(fs.readFileSync(compilerPath, 'utf8')).toBe('#!/bin/sh\n# first SDK\nexit 0\n');
});

it('uses the configured WASI SDK version for the cache path and release lookup', async () => {
    const workspaceRoot = temporaryDirectory('static-hermes-configured-sdk-');
    const installWasiSdk = vi.fn(({ destination }) => {
        writeExecutable(path.join(destination, 'bin', 'wasm32-wasip2-clang'));
        writeExecutable(path.join(destination, 'bin', 'wasm32-wasip2-clang++'));
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
            checksums: { 'linux/x64': 'b'.repeat(64) }
        },
        installWasiSdk
    });

    expect(installWasiSdk).toHaveBeenCalledWith(
        expect.objectContaining({
            version: '35',
            sha256: 'b'.repeat(64),
            destination: path.join(workspaceRoot, '.cache', 'hermes', 'toolchain', 'wasi-sdk-35')
        })
    );
});

it('uses the configured wit-bindgen version for its install cache', async () => {
    const workspaceRoot = temporaryDirectory('static-hermes-configured-bindgen-');
    const wasiSdk = path.join(workspaceRoot, 'wasi-sdk');
    writeExecutable(path.join(wasiSdk, 'bin', 'wasm32-wasip2-clang'));
    writeExecutable(path.join(wasiSdk, 'bin', 'wasm32-wasip2-clang++'));
    const installWitBindgen = vi.fn(({ destination, version }) => {
        writeExecutable(destination, `#!/bin/sh\necho "wit-bindgen-cli ${version} (fixture)"\n`);
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
    [
        'darwin',
        'arm64',
        'wasi-sdk-34.0-arm64-macos.tar.gz',
        '9c59398106b417f8f14913380fdf0097a8cc0ff4af9eb3ce0065a859e88d49e9'
    ],
    [
        'darwin',
        'x64',
        'wasi-sdk-34.0-x86_64-macos.tar.gz',
        '87d27fa8adc68dee59bfbf2e22a6d34ef717c34d6bf1d8af2a56fc929d9ce0eb'
    ],
    [
        'linux',
        'arm64',
        'wasi-sdk-34.0-arm64-linux.tar.gz',
        'f7e243dff54d60bcc576e94d6166b69f410f2500ae4a9ceef34315be10e77971'
    ],
    [
        'linux',
        'riscv64',
        'wasi-sdk-34.0-riscv64-linux.tar.gz',
        '71417f267b3a2015780b10045707eecec9fef6d064d2f79e82ad0618f9e4eac5'
    ],
    [
        'linux',
        'x64',
        'wasi-sdk-34.0-x86_64-linux.tar.gz',
        'b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4'
    ],
    [
        'win32',
        'arm64',
        'wasi-sdk-34.0-arm64-windows.tar.gz',
        '45e1c71f3e965621e7b98ebe1d37b0e4b1f77f3e8072113ffb4534e67b1a4b7c'
    ],
    [
        'win32',
        'x64',
        'wasi-sdk-34.0-x86_64-windows.tar.gz',
        'cccb5c323a9b34f0349a9b09e8804a0a7632c68c3310f4b5f437ed57d7e71d8f'
    ]
])('selects the pinned WASI SDK archive and checksum for %s/%s', (platform, arch, name, digest) => {
    const pinnedDigest = wasiSdkLock.checksums[`${platform}/${arch}`];
    expect(pinnedDigest).toBe(digest);
    const release = {
        assets: [
            { name: 'wasi-sdk-34.0-x86_64-linux.deb', browser_download_url: 'https://example.invalid/deb' },
            {
                name,
                browser_download_url: `https://example.invalid/${name}`,
                digest: `sha256:${digest}`
            }
        ]
    };

    expect(
        selectWasiSdkAsset(release, { version: wasiSdkLock.version, platform, arch, expectedSha256: pinnedDigest })
    ).toEqual(expect.objectContaining({ name, digest: `sha256:${digest}` }));
});

it('requires a checksum and a matching archive for the pinned WASI SDK release', () => {
    expect(() =>
        selectWasiSdkAsset(
            {
                assets: [{ name: 'wasi-sdk-34.0-x86_64-linux.tar.gz', browser_download_url: 'https://example.invalid' }]
            },
            { version: '34', platform: 'linux', arch: 'x64', expectedSha256: 'a'.repeat(64) }
        )
    ).toThrow(/SHA-256 digest/);
    expect(() =>
        selectWasiSdkAsset(
            { assets: [] },
            { version: '34', platform: 'freebsd', arch: 'x64', expectedSha256: 'a'.repeat(64) }
        )
    ).toThrow(/no WASI SDK 34 archive for freebsd\/x64/);
});

it('rejects release metadata whose SDK checksum differs from the lock pin', () => {
    const release = {
        assets: [
            {
                name: 'wasi-sdk-34.0-x86_64-linux.tar.gz',
                browser_download_url: 'https://example.invalid/sdk.tar.gz',
                digest: `sha256:${'a'.repeat(64)}`
            }
        ]
    };

    expect(() =>
        selectWasiSdkAsset(release, {
            version: '34',
            platform: 'linux',
            arch: 'x64',
            expectedSha256: 'b'.repeat(64)
        })
    ).toThrow(/does not match the pinned SHA-256/);
});

it('verifies downloaded WASI SDK bytes against the lock checksum', async () => {
    const archive = path.join(temporaryDirectory('static-hermes-sdk-archive-checksum-'), 'sdk.tar.gz');
    const archiveBytes = Buffer.from([1, 2, 3]);
    const expectedSha256 = createHash('sha256').update(archiveBytes).digest('hex');
    fs.writeFileSync(archive, archiveBytes);

    await expect(toolchainEnvironment.verifyWasiSdkArchiveChecksum(archive, expectedSha256)).resolves.toBeUndefined();

    await expect(toolchainEnvironment.verifyWasiSdkArchiveChecksum(archive, '0'.repeat(64))).rejects.toThrow(
        /WASI SDK checksum mismatch/
    );
});

it.each([
    [
        'darwin',
        'arm64',
        'wasm-tools-1.261.0-aarch64-macos.tar.gz',
        '94c4fc9baeada6e793f0d4adeca537633b5d93e9dc6bf718be2f478f4afe0296'
    ],
    [
        'darwin',
        'x64',
        'wasm-tools-1.261.0-x86_64-macos.tar.gz',
        '354a84ffeede30ba11f29bc72de76875a977cf43bf1c5bdc3e91e2313e8a854b'
    ],
    [
        'linux',
        'arm64',
        'wasm-tools-1.261.0-aarch64-linux.tar.gz',
        '6f19389a69e21c7dbd2a4e7ae72f807dc999988b48782c706c4102bad3e44487'
    ],
    [
        'linux',
        'x64',
        'wasm-tools-1.261.0-x86_64-linux.tar.gz',
        'ad62b2176037e93e1348cb65d6212d128ca9f097b63d155569f25215818ff7b1'
    ],
    [
        'win32',
        'arm64',
        'wasm-tools-1.261.0-aarch64-windows.zip',
        '284a9010b7d8bf35270c7814f853c4d0e87b0c9a697d696b3273e5bf07565d23'
    ],
    [
        'win32',
        'x64',
        'wasm-tools-1.261.0-x86_64-windows.zip',
        '250c6ee7d8073865a5cb42e1077f4246c72516af9b09d41d8a2734985ae673fd'
    ]
])('pins the wasm-tools archive and checksum for %s/%s', (platform, arch, name, digest) => {
    expect(selectWasmToolsAsset({ version: '1.261.0', platform, arch })).toEqual({
        name,
        url: `https://github.com/bytecodealliance/wasm-tools/releases/download/v1.261.0/${name}`,
        digest
    });
});

it('fails clearly for a platform without a pinned wasm-tools binary', () => {
    expect(() => selectWasmToolsAsset({ version: '1.261.0', platform: 'freebsd', arch: 'x64' })).toThrow(
        'no pinned wasm-tools 1.261.0 binary for freebsd/x64'
    );
});

it('rejects a configured wasm-tools executable with the wrong pinned version', async () => {
    const workspaceRoot = temporaryDirectory('static-hermes-wasm-tools-version-');
    const executable = path.join(workspaceRoot, 'wasm-tools');
    writeExecutable(executable, '#!/bin/sh\necho "wasm-tools 1.260.0 (fixture)"\n');

    await expect(
        setupHermesToolchainEnvironment({
            workspaceRoot,
            env: { WASM_TOOLS: executable },
            includeWasiSdk: false,
            includeWitBindgen: false,
            includeWasmTools: true
        })
    ).rejects.toThrow('configured wasm-tools must be wasm-tools 1.261.0: wasm-tools 1.260.0 (fixture)');
});

it('does not install a wasm-tools archive whose digest differs from the pinned release', async () => {
    const workspaceRoot = temporaryDirectory('static-hermes-wasm-tools-checksum-');
    const fetchImpl = vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
    }));

    await expect(
        setupHermesToolchainEnvironment({
            workspaceRoot,
            env: {},
            platform: 'linux',
            arch: 'x64',
            includeWasiSdk: false,
            includeWitBindgen: false,
            includeWasmTools: true,
            fetchImpl
        })
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
        'wasm-tools-1.261.0',
        'bin',
        'wasm-tools'
    );
    const installWasmTools = vi.fn(({ destination: executable }) => {
        writeExecutable(executable, '#!/bin/sh\necho "wasm-tools 1.261.0 (fixture)"\n');
        return executable;
    });

    const environment = await setupHermesToolchainEnvironment({
        workspaceRoot,
        env: {},
        platform: 'darwin',
        arch: 'arm64',
        includeWasiSdk: false,
        includeWitBindgen: false,
        includeWasmTools: true,
        installWasmTools
    });

    expect(installWasmTools).toHaveBeenCalledWith(
        expect.objectContaining({ version: '1.261.0', platform: 'darwin', arch: 'arm64', destination })
    );
    expect(environment.WASM_TOOLS).toBe(destination);
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

    expect(setupEnvironment).toHaveBeenCalledWith({ workspaceRoot: '/workspace', env, includeWasmTools: true });
    expect(prepare).toHaveBeenCalledOnce();
});

it('skips repeated Hermes preparation when the workspace build already prepared it', async () => {
    const env = { PUMPKIN_PLUGINS_STATIC_HERMES_PREPARED: '1' };
    const setupEnvironment = vi.fn(async () => ({ STATIC_HERMES_WASI_SDK_PATH: '/sdk' }));
    const prepare = vi.fn();

    await prepareStaticHermesBuild({
        workspaceRoot: '/workspace',
        env,
        setupEnvironment,
        prepare
    });

    expect(setupEnvironment).toHaveBeenCalledWith({ workspaceRoot: '/workspace', env, includeWasmTools: true });
    expect(prepare).not.toHaveBeenCalled();
});

function temporaryDirectory(prefix) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    temporaryDirs.push(directory);
    return directory;
}

function writeExecutable(file, contents = '#!/bin/sh\nexit 0\n') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    fs.chmodSync(file, 0o755);
}
