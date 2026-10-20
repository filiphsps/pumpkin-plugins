import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { HermesBuildOptions } from './build.ts';
import {
    acquireHermesBuildLock,
    buildHermes,
    hermesBuildFingerprint,
    hermesCMakeCommands,
    isHermesBuildCacheCurrent,
    requiredHermesArtifacts,
    saveHermesBuildCache,
    withHermesBuildLock,
} from './build.ts';
import { type HermesFileSystem, type HermesProcessRunner, hermesFileSystem } from './system.ts';

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
});

it('keeps the Hermes build fingerprint when runtime sources change but CMake inputs do not', () => {
    const { options, packageRoot } = fixture();
    const sources = ['src/hermes/build.ts', 'src/hermes/toolchain-environment.ts', 'src/cli.ts'].map((filename) =>
        path.join(packageRoot, filename),
    );
    for (const source of sources) fs.writeFileSync(source, 'export const version = 1;\n');
    const original = hermesBuildFingerprint(options);

    for (const source of sources) fs.writeFileSync(source, 'export const version = 2;\n');

    expect(hermesBuildFingerprint(options)).toBe(original);
});

it('keeps the Hermes build fingerprint when another GC variant rewrites the same host compiler imports', () => {
    const { options } = fixture();
    const imports = path.join(options.hostBuild, 'ImportHostCompilers.cmake');
    fs.mkdirSync(options.hostBuild, { recursive: true });
    fs.writeFileSync(imports, 'add_executable(imported-hermesc IMPORTED)\n');
    const original = hermesBuildFingerprint(options);

    // Every variant reconfigures the shared host build, and CMake rewrites this file each time.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(imports, later, later);
    expect(hermesBuildFingerprint(options)).toBe(original);

    fs.writeFileSync(imports, 'add_executable(imported-shermes IMPORTED)\n');
    expect(hermesBuildFingerprint(options)).not.toBe(original);
});

it('changes the Hermes build fingerprint when a CMake argument changes', () => {
    const { options } = fixture();
    const original = hermesBuildFingerprint(options);

    expect(hermesBuildFingerprint({ ...options, environment: { STATIC_HERMES_ENABLE_JSI_EXTENSIONS: '1' } })).not.toBe(
        original,
    );
    expect(hermesBuildFingerprint({ ...options, gcVariant: 'malloc' })).not.toBe(original);
});

it('marks only the WASI configure step as a WASI target', () => {
    const { options } = fixture();
    const [hostConfigure, , wasiConfigure] = hermesCMakeCommands(options, {});

    expect(wasiConfigure).toContain('-DHERMES_WASI_TARGET=ON');
    expect(hostConfigure?.some((argument) => argument.startsWith('-DHERMES_WASI_TARGET'))).toBe(false);
});

it('builds missing archives, reuses a current cache, and rebuilds when settings change', async () => {
    const { options, calls } = fixture();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await buildHermes(options);
    expect(cmakeCalls(calls)).toHaveLength(4);
    expect(fs.existsSync(path.join(options.cacheRoot, 'prepared-build-hades.json'))).toBe(true);
    expect(cmakeCalls(calls).find(({ args }) => args[0] === '-S' && args[3] === options.wasiBuild)?.args).toContain(
        '-DHERMESVM_GCKIND=HADES',
    );

    await buildHermes(options);
    expect(cmakeCalls(calls)).toHaveLength(4);

    const environment = options.environment;
    if (!environment) throw new Error('Fixture is missing its build environment');
    environment.STATIC_HERMES_ENABLE_JSI_EXTENSIONS = '1';
    await buildHermes(options);
    expect(cmakeCalls(calls)).toHaveLength(8);
    expect(cmakeCalls(calls).some(({ args }) => args.includes('-DHERMES_ENABLE_CORE_EXTENSIONS=ON'))).toBe(true);
    expect(fs.existsSync(path.join(options.cacheRoot, 'prepare.lock'))).toBe(false);
});

it('keeps Hades and malloc build artifacts cached independently', async () => {
    const { options, calls } = fixture();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const mallocOptions = { ...options, gcVariant: 'malloc' as const, wasiBuild: `${options.wasiBuild}-malloc` };

    await buildHermes(options);
    await buildHermes(mallocOptions);
    await buildHermes(options);

    const gcConfigurations = cmakeCalls(calls)
        .filter(({ args }) => args[0] === '-S' && args[3] !== options.hostBuild)
        .map(({ args }) => args.find((argument) => argument.startsWith('-DHERMESVM_GCKIND=')));
    expect(gcConfigurations).toEqual(['-DHERMESVM_GCKIND=HADES', '-DHERMESVM_GCKIND=MALLOC']);
    expect(fs.existsSync(path.join(options.cacheRoot, 'prepared-build-hades.json'))).toBe(true);
    expect(fs.existsSync(path.join(options.cacheRoot, 'prepared-build-malloc.json'))).toBe(true);
    expect(cmakeCalls(calls)).toHaveLength(8);
});

it('reuses a Hermes build that another install of the same runtime prepared and was then deleted', async () => {
    const { options, calls } = fixture();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Each external consumer installs its own copy of the runtime, and the whole consumer is deleted afterwards.
    const earlierInstall = path.join(path.dirname(options.packageRoot), 'earlier-consumer/runtime');
    fs.cpSync(options.packageRoot, earlierInstall, { recursive: true });
    await buildHermes({
        ...options,
        packageRoot: earlierInstall,
        toolchainFile: path.join(earlierInstall, 'cmake/wasi-sdk-hermes-p2.cmake'),
    });
    fs.rmSync(path.dirname(earlierInstall), { recursive: true });

    await buildHermes(options);

    expect(cmakeCalls(calls)).toHaveLength(4);
});

it.each([
    ['was deleted', false],
    ['belongs to another runtime install', true],
])(
    'configures the WASI build with this runtime toolchain when CMake set it up with one that %s',
    async (_, earlierToolchainExists) => {
        const { options, includedToolchains } = fixture();
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const earlierToolchain = path.join(path.dirname(options.packageRoot), 'earlier/cmake/wasi-sdk-hermes-p2.cmake');
        if (earlierToolchainExists) {
            fs.mkdirSync(path.dirname(earlierToolchain), { recursive: true });
            fs.writeFileSync(earlierToolchain, 'earlier toolchain fixture');
        }
        // An earlier install configured the tree first. A later configure from this install changed only the cache entry.
        fs.mkdirSync(path.join(options.wasiBuild, 'CMakeFiles/4.4.4'), { recursive: true });
        fs.writeFileSync(
            path.join(options.wasiBuild, 'CMakeFiles/4.4.4/CMakeSystem.cmake'),
            `include("${earlierToolchain}")\n`,
        );
        fs.writeFileSync(
            path.join(options.wasiBuild, 'CMakeCache.txt'),
            `CMAKE_TOOLCHAIN_FILE:UNINITIALIZED=${options.toolchainFile}\n`,
        );

        await buildHermes(options);

        expect(includedToolchains.at(-1)).toBe('toolchain fixture');
    },
);

it('builds with a read-only WASI SDK that already has the libc++ include marker', async () => {
    const { options, calls } = fixture();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const marker = path.join(options.wasiSdk, 'share/wasi-sysroot/include/c++/v1');
    fs.mkdirSync(marker, { recursive: true });
    options.filesystem = readOnlyBelow(options.wasiSdk);

    await buildHermes(options);

    expect(cmakeCalls(calls)).toHaveLength(4);
});

it('names the missing libc++ include marker when the WASI SDK is read-only', async () => {
    const { options, calls } = fixture();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    options.filesystem = readOnlyBelow(options.wasiSdk);

    const failure = await buildHermes(options).catch((error: unknown) => error);

    expect(String(failure)).toContain(path.join(options.wasiSdk, 'share/wasi-sysroot/include/c++/v1'));
    expect(String(failure)).toMatch(/libc\+\+ headers/);
    expect(cmakeCalls(calls)).toHaveLength(0);
});

it('releases the preparation lock when a CMake build fails', async () => {
    const { options, calls } = fixture({ failBuild: true });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(buildHermes(options)).rejects.toThrow('fixture CMake failure');

    expect(cmakeCalls(calls).some(({ args }) => args[0] === '--build')).toBe(true);
    expect(fs.existsSync(path.join(options.cacheRoot, 'prepare.lock'))).toBe(false);
    expect(fs.existsSync(path.join(options.cacheRoot, 'prepared-build.json'))).toBe(false);
});

it('serializes cache operations until the current preparation releases its lock', async () => {
    const { options } = fixture();
    const operations: string[] = [];
    let signalFirstEntered = (): void => undefined;
    let releaseFirst = (): void => undefined;
    const firstEntered = new Promise<void>((resolve) => {
        signalFirstEntered = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });

    const first = withHermesBuildLock(options.cacheRoot, async () => {
        operations.push('first:start');
        signalFirstEntered();
        await firstGate;
        operations.push('first:end');
    });
    await firstEntered;
    const second = withHermesBuildLock(options.cacheRoot, () => {
        operations.push('second');
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const operationsBeforeRelease = [...operations];

    releaseFirst();
    await Promise.all([first, second]);

    expect(operationsBeforeRelease).toEqual(['first:start']);
    expect(operations).toEqual(['first:start', 'first:end', 'second']);
    expect(fs.existsSync(path.join(options.cacheRoot, 'prepare.lock'))).toBe(false);
});

it('serializes separate cache roots that point at the same mutable Hermes directory', async () => {
    const { options } = fixture();
    const otherCacheRoot = `${options.cacheRoot}-other`;
    const operations: string[] = [];
    let signalFirstEntered = (): void => undefined;
    let releaseFirst = (): void => undefined;
    const firstEntered = new Promise<void>((resolve) => {
        signalFirstEntered = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });

    const first = withHermesBuildLock(
        options.cacheRoot,
        async () => {
            operations.push('first:start');
            signalFirstEntered();
            await firstGate;
            operations.push('first:end');
        },
        { resources: [options.source] },
    );
    await firstEntered;
    const second = withHermesBuildLock(
        otherCacheRoot,
        () => {
            operations.push('second');
        },
        { resources: [options.source] },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const operationsBeforeRelease = [...operations];

    releaseFirst();
    await Promise.all([first, second]);

    expect(operationsBeforeRelease).toEqual(['first:start']);
    expect(operations).toEqual(['first:start', 'first:end', 'second']);
});

it('does not remove a replacement lock owned by another preparation', async () => {
    const { options } = fixture();
    const lockPath = path.join(options.cacheRoot, 'prepare.lock');

    try {
        await withHermesBuildLock(options.cacheRoot, () => {
            const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { token?: unknown };
            expect(typeof owner.token).toBe('string');
            fs.rmSync(lockPath);
            fs.writeFileSync(
                lockPath,
                `${JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: 'replacement-owner' })}\n`,
            );
        });

        expect(fs.existsSync(lockPath)).toBe(true);
    } finally {
        fs.rmSync(lockPath, { force: true });
    }
});

it('removes a partially written Hermes lock when the owner write fails', async () => {
    const { options } = fixture();
    const lockPath = path.join(options.cacheRoot, 'partial-write.lock');
    let injectedFailure = false;
    const failingFilesystem: HermesFileSystem = {
        ...hermesFileSystem,
        writeFileSync(filename, data, writeOptions) {
            if (!injectedFailure && (typeof filename === 'number' || String(filename) === lockPath)) {
                injectedFailure = true;
                if (typeof filename === 'number') {
                    hermesFileSystem.writeFileSync(filename, '{"pid":');
                } else {
                    hermesFileSystem.writeFileSync(filename, '{"pid":', { flag: 'wx' });
                }
                throw Object.assign(new Error('fixture partial lock write'), { code: 'EIO' });
            }
            hermesFileSystem.writeFileSync(filename, data, writeOptions);
        },
    };

    await expect(acquireHermesBuildLock(lockPath, { filesystem: failingFilesystem })).rejects.toThrow(
        'fixture partial lock write',
    );

    expect(injectedFailure).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
});

it('preserves a replacement lock after a partial Hermes lock write fails', async () => {
    const { options } = fixture();
    const lockPath = path.join(options.cacheRoot, 'replacement-after-partial-write.lock');
    let replacementContents: string | undefined;
    let injectedFailure = false;
    let installedReplacement = false;
    const failingFilesystem: HermesFileSystem = {
        ...hermesFileSystem,
        writeFileSync(filename, data, writeOptions) {
            if (!injectedFailure && (typeof filename === 'number' || String(filename) === lockPath)) {
                injectedFailure = true;
                replacementContents = String(data);
                if (typeof filename === 'number') {
                    hermesFileSystem.writeFileSync(filename, '{"pid":');
                } else {
                    hermesFileSystem.writeFileSync(filename, '{"pid":', { flag: 'wx' });
                }
                throw Object.assign(new Error('fixture partial lock write'), { code: 'EIO' });
            }
            hermesFileSystem.writeFileSync(filename, data, writeOptions);
        },
        closeSync(descriptor: number) {
            hermesFileSystem.closeSync(descriptor);
            if (injectedFailure && !installedReplacement) {
                if (replacementContents === undefined) throw new Error('Fixture is missing the lock contents');
                fs.rmSync(lockPath, { force: true });
                fs.writeFileSync(lockPath, replacementContents);
                installedReplacement = true;
            }
        },
    };

    await expect(acquireHermesBuildLock(lockPath, { filesystem: failingFilesystem })).rejects.toThrow(
        'fixture partial lock write',
    );

    expect(injectedFailure).toBe(true);
    expect(installedReplacement).toBe(true);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(replacementContents);
});

it('does not let concurrent stale-lock recovery delete a replacement lock', async () => {
    const { options } = fixture();
    const lockPath = path.join(options.cacheRoot, 'stale-race.lock');
    fs.mkdirSync(options.cacheRoot, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999, startedAt: 1 }));
    let nestedAcquisition: Promise<string> | undefined;
    let injectedNestedRecovery = false;
    const raceFilesystem: HermesFileSystem = {
        ...hermesFileSystem,
        rmSync(filename, removeOptions) {
            if (!injectedNestedRecovery && path.resolve(String(filename)) === lockPath) {
                injectedNestedRecovery = true;
                nestedAcquisition = acquireHermesBuildLock(lockPath, {
                    filesystem: raceFilesystem,
                    timeoutMs: 20,
                    wait: async (delayMs) => new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 1))),
                    isProcessAlive: (pid) => pid === process.pid,
                });
            }
            hermesFileSystem.rmSync(filename, removeOptions);
        },
    };

    try {
        const firstOwnerToken = await acquireHermesBuildLock(lockPath, {
            filesystem: raceFilesystem,
            timeoutMs: 20,
            wait: async (delayMs) => new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 1))),
            isProcessAlive: (pid) => pid === process.pid,
        });
        expect(nestedAcquisition).toBeDefined();
        await expect(nestedAcquisition).rejects.toThrow(`Timed out waiting for Hermes build lock: ${lockPath}`);
        const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { token?: unknown };

        expect(owner.token).toBe(firstOwnerToken);
    } finally {
        fs.rmSync(lockPath, { force: true });
        fs.rmSync(`${lockPath}.reclaim`, { force: true });
    }
});

it('recovers a stale build lock when its recovery owner has exited', async () => {
    const { options } = fixture();
    const lockPath = path.join(options.cacheRoot, 'stale-recovery.lock');
    const reclaimLockPath = `${lockPath}.reclaim`;
    fs.mkdirSync(options.cacheRoot, { recursive: true });
    const staleLock = JSON.stringify({ pid: 99999999, startedAt: 1 });
    const abandonedClaim = JSON.stringify({ pid: 99999999, startedAt: 1, token: 'abandoned' });
    fs.writeFileSync(lockPath, staleLock);
    fs.writeFileSync(reclaimLockPath, abandonedClaim);

    const ownerToken = await acquireHermesBuildLock(lockPath, {
        timeoutMs: 10,
        isProcessAlive: () => false,
        wait: async (delayMs) => new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 1))),
    });
    const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { token?: unknown };

    expect(owner.token).toBe(ownerToken);
    expect(fs.existsSync(reclaimLockPath)).toBe(false);
    fs.rmSync(lockPath, { force: true });
});

it('keeps a live build recovery owner while waiting for a stale lock', async () => {
    const { options } = fixture();
    const lockPath = path.join(options.cacheRoot, 'live-recovery.lock');
    const reclaimLockPath = `${lockPath}.reclaim`;
    fs.mkdirSync(options.cacheRoot, { recursive: true });
    const staleLock = JSON.stringify({ pid: 99999999, startedAt: 1 });
    const liveClaim = JSON.stringify({ pid: process.pid, startedAt: 1, token: 'live-recovery' });
    fs.writeFileSync(lockPath, staleLock);
    fs.writeFileSync(reclaimLockPath, liveClaim);

    await expect(
        acquireHermesBuildLock(lockPath, {
            timeoutMs: 10,
            isProcessAlive: (pid) => pid === process.pid,
            wait: async (delayMs) => new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 1))),
        }),
    ).rejects.toThrow(`inspect recovery claim ${reclaimLockPath}`);

    expect(fs.readFileSync(lockPath, 'utf8')).toBe(staleLock);
    expect(fs.readFileSync(reclaimLockPath, 'utf8')).toBe(liveClaim);
    fs.rmSync(lockPath, { force: true });
    fs.rmSync(reclaimLockPath, { force: true });
});

it('builds and reuses Windows Hermes artifacts without probing MSVC as a GNU compiler', async () => {
    const { options, calls, outputCalls, setPlatform } = fixture();
    setPlatform('win32');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await buildHermes(options);

    const artifacts = requiredHermesArtifacts(options.hostBuild, options.wasiBuild, 'win32');
    expect(artifacts).toContain(path.join(options.hostBuild, 'bin/shermes.exe'));
    expect(artifacts).toContain(path.join(options.hostBuild, 'bin/hermesc.exe'));
    expect(fs.existsSync(path.join(options.hostBuild, 'bin/shermes.exe'))).toBe(true);
    expect(fs.existsSync(path.join(options.hostBuild, 'bin/hermesc.exe'))).toBe(true);
    expect(outputCalls.some(({ command }) => command === 'cc' || command === 'c++' || command === 'cl.exe')).toBe(
        false,
    );

    await buildHermes(options);

    expect(cmakeCalls(calls)).toHaveLength(4);
    const fingerprintBeforeArtifactChange = hermesBuildFingerprint(options);
    fs.appendFileSync(path.join(options.hostBuild, 'bin/hermesc.exe'), 'updated artifact');
    expect(hermesBuildFingerprint(options)).not.toBe(fingerprintBeforeArtifactChange);

    await buildHermes(options);

    expect(cmakeCalls(calls)).toHaveLength(8);
    const compilerMetadata = path.join(options.hostBuild, 'CMakeFiles/4.4.4/CMakeCCompiler.cmake');
    const staleCompilerMetadata = path.join(options.hostBuild, 'CMakeFiles/3.28.0/CMakeCCompiler.cmake');
    const activeCompilerMetadata = fs.readFileSync(compilerMetadata, 'utf8');
    fs.rmSync(compilerMetadata);
    const fingerprintWithoutActiveMetadata = hermesBuildFingerprint(options);
    fs.writeFileSync(
        staleCompilerMetadata,
        'set(CMAKE_C_COMPILER_ID "MSVC")\nset(CMAKE_C_COMPILER_VERSION "19.99.99999")\n',
    );
    expect(hermesBuildFingerprint(options)).toBe(fingerprintWithoutActiveMetadata);

    fs.writeFileSync(compilerMetadata, activeCompilerMetadata);
    const fingerprintBeforeCompilerUpdate = hermesBuildFingerprint(options);
    expect(hermesBuildFingerprint(options)).toBe(fingerprintBeforeCompilerUpdate);
    fs.writeFileSync(
        compilerMetadata,
        'set(CMAKE_C_COMPILER_ID "MSVC")\nset(CMAKE_C_COMPILER_VERSION "19.45.35207")\n',
    );
    expect(hermesBuildFingerprint(options)).not.toBe(fingerprintBeforeCompilerUpdate);

    await buildHermes(options);

    expect(cmakeCalls(calls)).toHaveLength(12);
    expect(outputCalls.some(({ command }) => command === 'cl.exe')).toBe(false);
});

it('omits GNU-only host compiler flags when configuring Hermes with MSVC', async () => {
    const { options, calls, setPlatform } = fixture();
    setPlatform('win32');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await buildHermes(options);

    const hostConfigure = cmakeCalls(calls).find(({ args }) => args[0] === '-S' && args[3] === options.hostBuild);
    expect(hostConfigure?.args).toContain('-DCMAKE_CXX_FLAGS_RELEASE=-Os -DNDEBUG');
    expect(hostConfigure?.args).not.toContain('-DCMAKE_CXX_FLAGS_RELEASE=-Os -DNDEBUG -Wno-unused-template');
});

it('validates and atomically saves the build cache fingerprint', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-build-cache-'));
    directories.push(root);
    const artifact = path.join(root, 'hermesvm.a');
    const state = path.join(root, 'prepared-build.json');
    fs.writeFileSync(artifact, 'archive');
    saveHermesBuildCache('a'.repeat(64), state, root);

    expect(isHermesBuildCacheCurrent('a'.repeat(64), state, [artifact])).toBe(true);
    expect(isHermesBuildCacheCurrent('b'.repeat(64), state, [artifact])).toBe(false);
    fs.writeFileSync(state, '{ invalid json');
    expect(isHermesBuildCacheCurrent('a'.repeat(64), state, [artifact])).toBe(false);
});

it('removes stale build locks, waits for live owners, and times out cleanly', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-build-cache-'));
    directories.push(root);
    const staleLock = path.join(root, 'stale.lock');
    fs.writeFileSync(staleLock, JSON.stringify({ pid: 99999999, startedAt: 1 }));
    await acquireHermesBuildLock(staleLock, { isProcessAlive: () => false, wait: async () => undefined });
    expect(JSON.parse(fs.readFileSync(staleLock, 'utf8')).pid).toBe(process.pid);

    const liveLock = path.join(root, 'live.lock');
    fs.writeFileSync(liveLock, JSON.stringify({ pid: 2, startedAt: 1 }));
    let time = 0;
    await expect(
        acquireHermesBuildLock(liveLock, {
            timeoutMs: 250,
            isProcessAlive: () => true,
            now: () => time,
            wait: async (delay) => {
                time += delay;
            },
        }),
    ).rejects.toThrow(`Timed out waiting for Hermes build lock: ${liveLock}`);
});

function fixture({ failBuild = false }: { failBuild?: boolean } = {}): {
    options: HermesBuildOptions;
    packageRoot: string;
    calls: Array<{ command: string; args: string[] }>;
    /** Contents of the toolchain file each WASI configure included, in call order. */
    includedToolchains: string[];
    outputCalls: Array<{ command: string; args: string[] }>;
    setPlatform(platform: NodeJS.Platform): void;
} {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-build-unit-'));
    directories.push(root);
    const packageRoot = path.join(root, 'runtime');
    const cacheRoot = path.join(root, 'cache');
    const source = path.join(root, 'source');
    const hostBuild = path.join(root, 'build-host');
    const wasiBuild = path.join(root, 'build-wasip2');
    const wasiSdk = path.join(root, 'wasi-sdk');
    const toolchainFile = path.join(packageRoot, 'cmake/wasi-sdk-hermes-p2.cmake');
    const pinFile = path.join(packageRoot, 'hermes-source.lock.json');
    const patchFile = path.join(packageRoot, 'hermes-patches/0001-fixture.patch');

    for (const directory of [
        path.join(packageRoot, 'src/hermes'),
        path.join(packageRoot, 'bin'),
        path.join(packageRoot, 'cmake'),
        path.dirname(patchFile),
        source,
        path.join(wasiSdk, 'bin'),
    ]) {
        fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(path.join(packageRoot, 'src/hermes/build.ts'), 'export {};\n');
    fs.writeFileSync(path.join(packageRoot, 'src/cli.ts'), '');
    fs.writeFileSync(path.join(packageRoot, 'src/hermes/toolchain-environment.ts'), '');
    fs.writeFileSync(path.join(packageRoot, 'toolchain-versions.json'), '{}\n');
    fs.writeFileSync(path.join(packageRoot, 'wasi-sdk.lock.json'), '{}\n');
    fs.writeFileSync(toolchainFile, 'toolchain fixture');
    fs.writeFileSync(pinFile, '{}\n');
    fs.writeFileSync(patchFile, 'patch fixture');

    const calls: Array<{ command: string; args: string[] }> = [];
    const includedToolchains: string[] = [];
    const outputCalls: Array<{ command: string; args: string[] }> = [];
    const process: HermesProcessRunner = {
        run(command, rawArgs) {
            const args = [...rawArgs];
            calls.push({ command, args });
            if (command === 'cmake' && args[0] === '-S') {
                const buildDirectory = args[3];
                if (!buildDirectory) throw new Error('CMake build directory is missing');
                fs.mkdirSync(buildDirectory, { recursive: true });
                const toolchain = args
                    .find((argument) => argument.startsWith('-DCMAKE_TOOLCHAIN_FILE='))
                    ?.slice('-DCMAKE_TOOLCHAIN_FILE='.length);
                if (toolchain) includedToolchains.push(includeRecordedToolchain(buildDirectory, toolchain));
                const compiler =
                    buildDirectory === hostBuild
                        ? 'C:/BuildTools/VC/Tools/MSVC/bin/Hostx64/x64/cl.exe'
                        : 'C:/wasi-sdk/bin/wasm32-wasip2-clang.exe';
                const compilerCache =
                    optionsPlatform === 'win32'
                        ? `${[`CMAKE_C_COMPILER:FILEPATH=${compiler}`, `CMAKE_CXX_COMPILER:FILEPATH=${compiler}`].join(
                              '\n',
                          )}\n`
                        : '';
                const toolchainCache = toolchain ? `CMAKE_TOOLCHAIN_FILE:UNINITIALIZED=${toolchain}\n` : '';
                fs.writeFileSync(path.join(buildDirectory, 'CMakeCache.txt'), `${compilerCache}${toolchainCache}`);
                if (optionsPlatform === 'win32') {
                    const compilerId = buildDirectory === hostBuild ? 'MSVC' : 'Clang';
                    const compilerVersion = buildDirectory === hostBuild ? '19.44.35207' : '20.1.0';
                    for (const [cmakeDirectory, recordedVersion] of [
                        ['3.28.0', '19.99.99999'],
                        ['4.4.4', compilerVersion],
                    ]) {
                        const cmakeFiles = path.join(buildDirectory, 'CMakeFiles', cmakeDirectory);
                        fs.mkdirSync(cmakeFiles, { recursive: true });
                        for (const compilerFile of ['CMakeCCompiler.cmake', 'CMakeCXXCompiler.cmake']) {
                            fs.writeFileSync(
                                path.join(cmakeFiles, compilerFile),
                                `set(${compilerFile === 'CMakeCCompiler.cmake' ? 'CMAKE_C' : 'CMAKE_CXX'}_COMPILER_ID "${compilerId}")\nset(${compilerFile === 'CMakeCCompiler.cmake' ? 'CMAKE_C' : 'CMAKE_CXX'}_COMPILER_VERSION "${recordedVersion}")\n`,
                            );
                        }
                    }
                }
                return;
            }
            if (command !== 'cmake' || args[0] !== '--build') return;
            if (failBuild) throw new Error('fixture CMake failure');

            const buildDirectory = args[1];
            if (!buildDirectory) throw new Error('CMake build directory is missing');
            if (buildDirectory === hostBuild) {
                writeArtifact(path.join(hostBuild, 'ImportHostCompilers.cmake'));
                writeArtifact(path.join(hostBuild, 'bin', optionsPlatform === 'win32' ? 'shermes.exe' : 'shermes'));
                writeArtifact(path.join(hostBuild, 'bin', optionsPlatform === 'win32' ? 'hermesc.exe' : 'hermesc'));
            } else {
                writeArtifact(path.join(buildDirectory, 'lib/libhermesvm_a.a'));
                writeArtifact(path.join(buildDirectory, 'lib/libhermesvmlean_a.a'));
                writeArtifact(path.join(buildDirectory, 'jsi/libjsi.a'));
            }
        },
        output(command, args) {
            outputCalls.push({ command, args: [...args] });
            if (command === 'cmake') return 'cmake version 4.4.4';
            if (command === 'git') {
                if (args.includes('rev-parse')) return '820aa0d4b5fe5d3ed7900e1274211ef561081b3f';
                return '';
            }
            return `fixture ${path.basename(command)} version`;
        },
        buffer() {
            return Buffer.alloc(0);
        },
    };

    let optionsPlatform: NodeJS.Platform | undefined;
    const options: HermesBuildOptions = {
        packageRoot,
        cacheRoot,
        source,
        hostBuild,
        wasiBuild,
        wasiSdk,
        toolchainFile,
        pinFile,
        pin: {
            repository: 'https://github.com/facebook/hermes.git',
            branch: 'static_h',
            commit: '820aa0d4b5fe5d3ed7900e1274211ef561081b3f',
        },
        patches: [{ name: '0001-fixture.patch', filename: patchFile, sequence: 1, affectedPaths: ['src/a.cpp'] }],
        environment: {},
        process,
    };
    return {
        packageRoot,
        calls,
        includedToolchains,
        outputCalls,
        options,
        setPlatform(platform) {
            optionsPlatform = platform;
            options.platform = platform;
        },
    };
}

/** Return a filesystem that refuses to create directories inside the given directory, like a read-only mount. */
function readOnlyBelow(directory: string): HermesFileSystem {
    return {
        ...hermesFileSystem,
        mkdirSync(target, mkdirOptions) {
            if (!path.relative(directory, String(target)).startsWith('..')) {
                throw Object.assign(new Error(`EACCES: permission denied, mkdir '${String(target)}'`), {
                    code: 'EACCES',
                });
            }
            return hermesFileSystem.mkdirSync(target, mkdirOptions);
        },
    };
}

/**
 * Include a build tree's toolchain file the way CMake does: the first configure records the
 * `CMAKE_TOOLCHAIN_FILE` it was given, and every later configure includes that recorded file instead.
 */
function includeRecordedToolchain(buildDirectory: string, toolchain: string): string {
    const system = path.join(buildDirectory, 'CMakeFiles/4.4.4/CMakeSystem.cmake');
    if (!fs.existsSync(system)) {
        fs.mkdirSync(path.dirname(system), { recursive: true });
        fs.writeFileSync(system, `include("${toolchain}")\n`);
    }
    const included = fs.readFileSync(system, 'utf8').match(/^include\("(.*)"\)$/m)?.[1] ?? '';
    if (!fs.existsSync(included)) throw new Error(`include could not find requested file: ${included}`);
    return fs.readFileSync(included, 'utf8');
}

function writeArtifact(filename: string): void {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    if (fs.existsSync(filename) && fs.readFileSync(filename, 'utf8') === 'fixture artifact') return;
    fs.writeFileSync(filename, 'fixture artifact');
}

function cmakeCalls(calls: Array<{ command: string; args: string[] }>): Array<{ command: string; args: string[] }> {
    return calls.filter(({ command }) => command === 'cmake');
}
