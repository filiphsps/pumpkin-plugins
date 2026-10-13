import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConsumerWorkspaceRoot } from '../workspace-root.ts';
import { buildHermes, buildHermesWithLockHeld, withHermesBuildLock } from './build.ts';
import { affectedHermesPaths, applyHermesPatchSeries, readHermesPatchSeries } from './patch.ts';
import { ensureHermesSource, readHermesSourcePin, refreshHermesSource } from './source.ts';
import { setupHermesToolchainEnvironment } from './toolchain-environment.ts';

/** Optional paths, environment, and setup hook for Hermes preparation. */
export interface HermesPreparationOptions {
    /** Project root for caches; defaults to the nearest pnpm workspace, or the current directory if standalone. */
    workspaceRoot?: string;
    /** Root of `tools/static-hermes-runtime`; defaults to this package's location. */
    packageRoot?: string;
    /** Environment used to select source, cache, and toolchain locations. */
    environment?: NodeJS.ProcessEnv;
    /** Optional setup hook for resolving the tools needed by Hermes preparation. */
    setupEnvironment?: (options: {
        workspaceRoot: string;
        env: NodeJS.ProcessEnv;
        includeWitBindgen: false;
    }) => Promise<Record<string, string>>;
}

/** Ordered source, patch, and build stages for Hermes preparation. */
export interface HermesStageRunner {
    /** Ensure the repository is checked out at its pinned commit. */
    source(): Promise<void> | void;
    /** Apply the configured patches to the pinned checkout. */
    patch(): Promise<void> | void;
    /** Build or reuse the host compiler and WASI archives. */
    build(): Promise<void> | void;
}

/**
 * Run the named Hermes stages in source, patch, then build order.
 *
 * @param stages - Implementations for each preparation stage.
 */
export async function runHermesPreparationStages(stages: HermesStageRunner): Promise<void> {
    await stages.source();
    await stages.patch();
    await stages.build();
}

/**
 * Ensure the pinned source, apply its patch series, then prepare host and WASI build artifacts.
 *
 * @param options - Optional workspace, package, environment, and toolchain setup overrides.
 */
export async function prepareHermes(options: HermesPreparationOptions = {}): Promise<void> {
    const context = createHermesContext(options);
    await setupBuildEnvironment(context);
    const paths = configuredHermesPaths(context.packageRoot, context.workspaceRoot, context.environment);
    const pin = readHermesSourcePin(paths.pinFile);
    const patches = readHermesPatchSeries(paths.patchesDirectory);
    await withHermesBuildLock(
        paths.cacheRoot,
        async () => {
            await runHermesPreparationStages({
                source: () => {
                    ensurePinnedSource(paths, pin, patches);
                },
                patch: () => {
                    try {
                        applyCurrentPatches(paths.source, pin.commit, patches);
                    } catch (error) {
                        if (!(error instanceof Error) || !error.message.includes('conflict or partial application')) {
                            throw error;
                        }
                        refreshHermesSource({
                            pin,
                            source: paths.source,
                            managedSource: paths.managedSource,
                            managedPaths: affectedHermesPaths(patches)
                        });
                        console.log(
                            'Rebuilt stale Hermes source cache from the pinned commit; applying current patch series.'
                        );
                        applyCurrentPatches(paths.source, pin.commit, patches);
                    }
                },
                build: () => buildCurrentHermes(context, paths, pin, patches, buildHermesWithLockHeld)
            });
        },
        { resources: [paths.source, paths.hostBuild, paths.wasiBuild] }
    );
}

/**
 * Ensure only the pinned checkout, without applying any bundled patches.
 *
 * @param options - Optional workspace, package, environment, and toolchain setup overrides.
 * @returns The verified source checkout path.
 */
export async function prepareHermesSource(options: HermesPreparationOptions = {}): Promise<string> {
    const context = createHermesContext(options);
    const paths = configuredHermesPaths(context.packageRoot, context.workspaceRoot, context.environment);
    const pin = readHermesSourcePin(paths.pinFile);
    const patches = readHermesPatchSeries(paths.patchesDirectory);
    return withHermesBuildLock(paths.cacheRoot, () => ensurePinnedSource(paths, pin, patches), {
        resources: [paths.source]
    });
}

/**
 * Apply only the ordered patch series to a previously prepared source checkout.
 *
 * @param options - Optional workspace, package, environment, and toolchain setup overrides.
 * @throws {Error} If the source checkout is missing or a patch cannot be applied safely.
 */
export async function patchHermesSource(options: HermesPreparationOptions = {}): Promise<void> {
    const context = createHermesContext(options);
    const paths = configuredHermesPaths(context.packageRoot, context.workspaceRoot, context.environment);
    const pin = readHermesSourcePin(paths.pinFile);
    const patches = readHermesPatchSeries(paths.patchesDirectory);
    await withHermesBuildLock(
        paths.cacheRoot,
        () => {
            if (!fs.existsSync(paths.source)) {
                throw new Error(`Hermes source not found at ${paths.source}; run hermes source first`);
            }
            applyCurrentPatches(paths.source, pin.commit, patches);
        },
        { resources: [paths.source] }
    );
}

/**
 * Build host and WASI archives from an existing pinned, patched source checkout.
 *
 * @param options - Optional workspace, package, environment, and toolchain setup overrides.
 */
export async function buildHermesArtifacts(options: HermesPreparationOptions = {}): Promise<void> {
    const context = createHermesContext(options);
    await setupBuildEnvironment(context);
    const paths = configuredHermesPaths(context.packageRoot, context.workspaceRoot, context.environment);
    const pin = readHermesSourcePin(paths.pinFile);
    const patches = readHermesPatchSeries(paths.patchesDirectory);
    await buildCurrentHermes(context, paths, pin, patches);
}

interface HermesContext {
    packageRoot: string;
    workspaceRoot: string;
    environment: NodeJS.ProcessEnv;
    setupEnvironment: NonNullable<HermesPreparationOptions['setupEnvironment']>;
}

interface HermesPaths {
    cacheRoot: string;
    source: string;
    managedSource: boolean;
    hostBuild: string;
    wasiBuild: string;
    wasiSdk: string;
    pinFile: string;
    patchesDirectory: string;
    toolchainFile: string;
}

function createHermesContext(options: HermesPreparationOptions): HermesContext {
    const packageRoot = path.resolve(
        options.packageRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
    );
    const workspaceRoot = path.resolve(options.workspaceRoot ?? resolveConsumerWorkspaceRoot());
    return {
        packageRoot,
        workspaceRoot,
        environment: options.environment ?? process.env,
        setupEnvironment: options.setupEnvironment ?? setupHermesToolchainEnvironment
    };
}

async function setupBuildEnvironment(context: HermesContext): Promise<void> {
    const environment = await context.setupEnvironment({
        workspaceRoot: context.workspaceRoot,
        env: context.environment,
        includeWitBindgen: false
    });
    Object.assign(context.environment, environment);
}

function configuredHermesPaths(
    packageRoot: string,
    workspaceRoot: string,
    environment: NodeJS.ProcessEnv
): HermesPaths {
    const cacheRoot = path.resolve(environment.STATIC_HERMES_CACHE_DIR ?? path.join(workspaceRoot, '.cache/hermes'));
    const defaultSource = path.join(cacheRoot, 'source');
    const source = path.resolve(environment.STATIC_HERMES_SOURCE_DIR ?? defaultSource);
    return {
        cacheRoot,
        source,
        managedSource: source === path.resolve(defaultSource),
        hostBuild: path.resolve(environment.STATIC_HERMES_HOST_BUILD_DIR ?? path.join(cacheRoot, 'build-host')),
        wasiBuild: path.resolve(environment.STATIC_HERMES_WASI_BUILD_DIR ?? path.join(cacheRoot, 'build-wasip2')),
        wasiSdk: path.resolve(environment.STATIC_HERMES_WASI_SDK_PATH ?? ''),
        pinFile: path.join(packageRoot, 'hermes-source.lock.json'),
        patchesDirectory: path.join(packageRoot, 'hermes-patches'),
        toolchainFile: path.join(packageRoot, 'cmake/wasi-sdk-hermes-p2.cmake')
    };
}

function ensurePinnedSource(
    paths: HermesPaths,
    pin: ReturnType<typeof readHermesSourcePin>,
    patches: ReturnType<typeof readHermesPatchSeries>
): string {
    return ensureHermesSource({
        pin,
        source: paths.source,
        managedSource: paths.managedSource,
        managedPaths: affectedHermesPaths(patches)
    });
}

function applyCurrentPatches(
    source: string,
    expectedCommit: string,
    patches: ReturnType<typeof readHermesPatchSeries>
): void {
    applyHermesPatchSeries({ source, expectedCommit, patches });
}

async function buildCurrentHermes(
    context: HermesContext,
    paths: HermesPaths,
    pin: ReturnType<typeof readHermesSourcePin>,
    patches: ReturnType<typeof readHermesPatchSeries>,
    build: typeof buildHermes = buildHermes
): Promise<void> {
    if (!context.environment.STATIC_HERMES_WASI_SDK_PATH) {
        throw new Error('Static Hermes WASI SDK path is not configured; run the Hermes build setup first');
    }
    await build({
        packageRoot: context.packageRoot,
        cacheRoot: paths.cacheRoot,
        source: paths.source,
        hostBuild: paths.hostBuild,
        wasiBuild: paths.wasiBuild,
        wasiSdk: paths.wasiSdk,
        toolchainFile: paths.toolchainFile,
        pinFile: paths.pinFile,
        pin,
        patches,
        environment: context.environment
    });
}
