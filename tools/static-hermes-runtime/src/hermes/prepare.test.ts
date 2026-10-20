import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { prepareHermes } from './prepare.ts';

const mocks = vi.hoisted(() => ({
    setupToolchain: vi.fn(),
    buildHermes: vi.fn(),
    buildHermesWithLockHeld: vi.fn(),
    withBuildLock: vi.fn(),
    affectedPaths: vi.fn(),
    applyPatches: vi.fn(),
    readPatches: vi.fn(),
    ensureSource: vi.fn(),
    readPin: vi.fn(),
    refreshSource: vi.fn(),
}));

vi.mock('./toolchain-environment.ts', () => ({ setupHermesToolchainEnvironment: mocks.setupToolchain }));
vi.mock('./build.ts', () => ({
    buildHermes: mocks.buildHermes,
    buildHermesWithLockHeld: mocks.buildHermesWithLockHeld,
    withHermesBuildLock: mocks.withBuildLock,
}));
vi.mock('./patch.ts', () => ({
    affectedHermesPaths: mocks.affectedPaths,
    applyHermesPatchSeries: mocks.applyPatches,
    HermesPatchConflictError: class extends Error {},
    readHermesPatchSeries: mocks.readPatches,
}));
vi.mock('./source.ts', () => ({
    ensureHermesSource: mocks.ensureSource,
    readHermesSourcePin: mocks.readPin,
    refreshHermesSource: mocks.refreshSource,
}));

const pin = {
    repository: 'https://github.com/facebook/hermes.git',
    branch: 'static_h',
    commit: '820aa0d4b5fe5d3ed7900e1274211ef561081b3f',
};
const patches = [{ name: '0001-static.patch', filename: '/package/hermes-patches/0001-static.patch' }];

beforeEach(() => {
    mocks.setupToolchain.mockReset().mockResolvedValue({
        STATIC_HERMES_CACHE_DIR: '/cache/hermes',
        STATIC_HERMES_WASI_SDK_PATH: '/toolchain/wasi-sdk',
    });
    mocks.buildHermes.mockReset().mockResolvedValue(undefined);
    mocks.buildHermesWithLockHeld.mockReset().mockResolvedValue(undefined);
    mocks.withBuildLock.mockReset().mockImplementation(async (_cacheRoot, operation) => operation());
    mocks.affectedPaths.mockReset().mockReturnValue(['lib/Runtime.cpp']);
    mocks.applyPatches.mockReset();
    mocks.readPatches.mockReset().mockReturnValue(patches);
    mocks.ensureSource.mockReset().mockReturnValue('/cache/hermes/source');
    mocks.readPin.mockReset().mockReturnValue(pin);
    mocks.refreshSource.mockReset();
});

it('runs source validation, patching, and building in order', async () => {
    const stages: string[] = [];
    mocks.ensureSource.mockImplementation(() => stages.push('source'));
    mocks.applyPatches.mockImplementation(() => stages.push('patch'));
    mocks.buildHermesWithLockHeld.mockImplementation(async () => {
        stages.push('build');
    });

    await prepareHermes({ workspaceRoot: '/workspace', packageRoot: '/package', environment: {} });

    expect(stages).toEqual(['source', 'patch', 'build']);
});

it('stops before patching or building when source validation fails', async () => {
    const failure = new Error('source pin mismatch');
    mocks.ensureSource.mockImplementation(() => {
        throw failure;
    });

    await expect(prepareHermes({ workspaceRoot: '/workspace', packageRoot: '/package', environment: {} })).rejects.toBe(
        failure,
    );
    expect(mocks.applyPatches).not.toHaveBeenCalled();
    expect(mocks.buildHermesWithLockHeld).not.toHaveBeenCalled();
});

it('prepares the pinned source, applies patches, and builds with resolved cache paths', async () => {
    const environment: NodeJS.ProcessEnv = {};

    await prepareHermes({ workspaceRoot: '/workspace', packageRoot: '/package', environment });

    expect(mocks.setupToolchain).toHaveBeenCalledWith({
        workspaceRoot: '/workspace',
        env: environment,
        includeWitBindgen: false,
    });
    expect(mocks.readPin).toHaveBeenCalledWith('/package/hermes-source.lock.json');
    expect(mocks.readPatches).toHaveBeenCalledWith('/package/hermes-patches');
    expect(mocks.ensureSource).toHaveBeenCalledWith({
        pin,
        source: '/cache/hermes/source',
        managedSource: true,
        managedPaths: ['lib/Runtime.cpp'],
    });
    expect(mocks.applyPatches).toHaveBeenCalledWith({
        source: '/cache/hermes/source',
        expectedCommit: pin.commit,
        patches,
    });
    expect(mocks.withBuildLock).toHaveBeenCalledWith('/cache/hermes', expect.any(Function), {
        resources: ['/cache/hermes/source', '/cache/hermes/build-host', '/cache/hermes/build-wasip2'],
    });
    expect(mocks.buildHermesWithLockHeld).toHaveBeenCalledWith(
        expect.objectContaining({
            packageRoot: '/package',
            cacheRoot: '/cache/hermes',
            source: '/cache/hermes/source',
            hostBuild: '/cache/hermes/build-host',
            wasiBuild: '/cache/hermes/build-wasip2',
            wasiSdk: '/toolchain/wasi-sdk',
            toolchainFile: '/package/cmake/wasi-sdk-hermes-p2.cmake',
            pin,
            patches,
            environment,
        }),
    );
});

it('serializes preparations that share an overridden source across independent cache roots', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-shared-source-'));
    const firstCache = path.join(root, 'cache-first');
    const secondCache = path.join(root, 'cache-second');
    const sharedSource = path.join(root, 'shared-source');
    fs.mkdirSync(sharedSource, { recursive: true });
    const { withHermesBuildLock: realBuildLock } = await vi.importActual<typeof import('./build.ts')>('./build.ts');
    mocks.withBuildLock.mockImplementation((cacheRoot, operation, options) =>
        realBuildLock(cacheRoot, operation, options),
    );
    mocks.setupToolchain.mockImplementation(async () => ({ STATIC_HERMES_WASI_SDK_PATH: '/toolchain/wasi-sdk' }));

    let markFirstBuildEntered = (): void => undefined;
    let releaseFirstBuild = (): void => undefined;
    const firstBuildEntered = new Promise<void>((resolve) => {
        markFirstBuildEntered = resolve;
    });
    const firstBuildGate = new Promise<void>((resolve) => {
        releaseFirstBuild = resolve;
    });
    const buildStarts: string[] = [];
    mocks.buildHermesWithLockHeld.mockImplementation(async ({ cacheRoot }) => {
        buildStarts.push(cacheRoot);
        if (cacheRoot === firstCache) {
            markFirstBuildEntered();
            await firstBuildGate;
        }
    });

    const createEnvironment = (cacheRoot: string): NodeJS.ProcessEnv => ({
        STATIC_HERMES_CACHE_DIR: cacheRoot,
        STATIC_HERMES_SOURCE_DIR: sharedSource,
        STATIC_HERMES_HOST_BUILD_DIR: path.join(cacheRoot, 'host-build'),
        STATIC_HERMES_WASI_BUILD_DIR: path.join(cacheRoot, 'wasi-build'),
    });

    try {
        const first = prepareHermes({
            workspaceRoot: root,
            packageRoot: '/package',
            environment: createEnvironment(firstCache),
        });
        await firstBuildEntered;
        const second = prepareHermes({
            workspaceRoot: root,
            packageRoot: '/package',
            environment: createEnvironment(secondCache),
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        const startsBeforeRelease = [...buildStarts];

        releaseFirstBuild();
        await Promise.all([first, second]);

        expect(startsBeforeRelease).toEqual([firstCache]);
        expect(buildStarts).toEqual([firstCache, secondCache]);
    } finally {
        releaseFirstBuild();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

it('uses the consumer working directory when the runtime package is installed under node_modules', async () => {
    const consumerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-prepare-consumer-'));
    const originalWorkingDirectory = process.cwd();
    const packageRoot = path.join(consumerRoot, 'node_modules/@pumpkin-plugins/static-hermes-runtime');
    fs.mkdirSync(packageRoot, { recursive: true });
    process.chdir(consumerRoot);
    const expectedWorkspaceRoot = process.cwd();

    try {
        await prepareHermes({ packageRoot, environment: {} });

        expect(mocks.setupToolchain.mock.calls[0]?.[0].workspaceRoot).toBe(expectedWorkspaceRoot);
        expect(mocks.setupToolchain.mock.calls[0]?.[0].includeWitBindgen).toBe(false);
        expect(mocks.readPin).toHaveBeenCalledWith(path.join(packageRoot, 'hermes-source.lock.json'));
    } finally {
        process.chdir(originalWorkingDirectory);
        fs.rmSync(consumerRoot, { recursive: true, force: true });
    }
});

it('waits for the preparation lock before touching source, patches, or build artifacts', async () => {
    let markLockEntered = (): void => undefined;
    let releaseLock = (): void => undefined;
    const lockEntered = new Promise<void>((resolve) => {
        markLockEntered = resolve;
    });
    const lockGate = new Promise<void>((resolve) => {
        releaseLock = resolve;
    });
    mocks.withBuildLock.mockImplementation(async (_cacheRoot, operation) => {
        markLockEntered();
        await lockGate;
        return operation();
    });

    const preparation = prepareHermes({ workspaceRoot: '/workspace', packageRoot: '/package', environment: {} });
    await lockEntered;

    expect(mocks.ensureSource).not.toHaveBeenCalled();
    expect(mocks.applyPatches).not.toHaveBeenCalled();
    expect(mocks.buildHermesWithLockHeld).not.toHaveBeenCalled();

    releaseLock();
    await preparation;

    expect(mocks.ensureSource).toHaveBeenCalledOnce();
    expect(mocks.applyPatches).toHaveBeenCalledOnce();
    expect(mocks.buildHermesWithLockHeld).toHaveBeenCalledOnce();
});

it('rejects build preparation when setup did not provide a WASI SDK', async () => {
    mocks.setupToolchain.mockResolvedValue({ STATIC_HERMES_CACHE_DIR: '/cache/hermes' });

    await expect(
        prepareHermes({ workspaceRoot: '/workspace', packageRoot: '/package', environment: {} }),
    ).rejects.toThrow('Static Hermes WASI SDK path is not configured');
    expect(mocks.ensureSource).toHaveBeenCalledOnce();
    expect(mocks.applyPatches).toHaveBeenCalledOnce();
    expect(mocks.buildHermes).not.toHaveBeenCalled();
});
