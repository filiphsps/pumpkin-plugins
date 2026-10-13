import { beforeEach, expect, it, vi } from 'vitest';
import { prepareHermes, runHermesPreparationStages } from './prepare.ts';

const mocks = vi.hoisted(() => ({
    setupToolchain: vi.fn(),
    buildHermes: vi.fn(),
    affectedPaths: vi.fn(),
    applyPatches: vi.fn(),
    readPatches: vi.fn(),
    ensureSource: vi.fn(),
    readPin: vi.fn(),
    refreshSource: vi.fn()
}));

vi.mock('./toolchain-environment.ts', () => ({ setupHermesToolchainEnvironment: mocks.setupToolchain }));
vi.mock('./build.ts', () => ({ buildHermes: mocks.buildHermes }));
vi.mock('./patch.ts', () => ({
    affectedHermesPaths: mocks.affectedPaths,
    applyHermesPatchSeries: mocks.applyPatches,
    readHermesPatchSeries: mocks.readPatches
}));
vi.mock('./source.ts', () => ({
    ensureHermesSource: mocks.ensureSource,
    readHermesSourcePin: mocks.readPin,
    refreshHermesSource: mocks.refreshSource
}));

const pin = {
    repository: 'https://github.com/facebook/hermes.git',
    branch: 'static_h',
    commit: '820aa0d4b5fe5d3ed7900e1274211ef561081b3f'
};
const patches = [{ name: '0001-static.patch', filename: '/package/hermes-patches/0001-static.patch' }];

beforeEach(() => {
    mocks.setupToolchain.mockReset().mockResolvedValue({
        STATIC_HERMES_CACHE_DIR: '/cache/hermes',
        STATIC_HERMES_WASI_SDK_PATH: '/toolchain/wasi-sdk'
    });
    mocks.buildHermes.mockReset().mockResolvedValue(undefined);
    mocks.affectedPaths.mockReset().mockReturnValue(['lib/Runtime.cpp']);
    mocks.applyPatches.mockReset();
    mocks.readPatches.mockReset().mockReturnValue(patches);
    mocks.ensureSource.mockReset().mockReturnValue('/cache/hermes/source');
    mocks.readPin.mockReset().mockReturnValue(pin);
    mocks.refreshSource.mockReset();
});

it('runs source validation, patching, and building in order', async () => {
    const stages: string[] = [];

    await runHermesPreparationStages({
        source() {
            stages.push('source');
        },
        async patch() {
            await Promise.resolve();
            stages.push('patch');
        },
        build() {
            stages.push('build');
        }
    });

    expect(stages).toEqual(['source', 'patch', 'build']);
});

it('stops before patching or building when source validation fails', async () => {
    const failure = new Error('source pin mismatch');
    const patch = vi.fn();
    const build = vi.fn();

    await expect(
        runHermesPreparationStages({
            source() {
                throw failure;
            },
            patch,
            build
        })
    ).rejects.toBe(failure);
    expect(patch).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
});

it('prepares the pinned source, applies patches, and builds with resolved cache paths', async () => {
    const environment: NodeJS.ProcessEnv = {};

    await prepareHermes({ workspaceRoot: '/workspace', packageRoot: '/package', environment });

    expect(mocks.setupToolchain).toHaveBeenCalledWith({
        workspaceRoot: '/workspace',
        env: environment,
        includeWitBindgen: false
    });
    expect(mocks.readPin).toHaveBeenCalledWith('/package/hermes-source.lock.json');
    expect(mocks.readPatches).toHaveBeenCalledWith('/package/hermes-patches');
    expect(mocks.ensureSource).toHaveBeenCalledWith({
        pin,
        source: '/cache/hermes/source',
        managedSource: true,
        managedPaths: ['lib/Runtime.cpp']
    });
    expect(mocks.applyPatches).toHaveBeenCalledWith({
        source: '/cache/hermes/source',
        expectedCommit: pin.commit,
        patches
    });
    expect(mocks.buildHermes).toHaveBeenCalledWith(
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
            environment
        })
    );
});

it('rejects build preparation when setup did not provide a WASI SDK', async () => {
    mocks.setupToolchain.mockResolvedValue({ STATIC_HERMES_CACHE_DIR: '/cache/hermes' });

    await expect(
        prepareHermes({ workspaceRoot: '/workspace', packageRoot: '/package', environment: {} })
    ).rejects.toThrow('Static Hermes WASI SDK path is not configured');
    expect(mocks.ensureSource).toHaveBeenCalledOnce();
    expect(mocks.applyPatches).toHaveBeenCalledOnce();
    expect(mocks.buildHermes).not.toHaveBeenCalled();
});
