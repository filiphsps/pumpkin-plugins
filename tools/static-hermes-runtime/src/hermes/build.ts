import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HermesGcVariant } from './gc.ts';
import { ensurePatchOnlyChanges, type HermesPatch, verifyHermesPatchSeriesApplied } from './patch.ts';
import type { HermesSourcePin } from './source.ts';
import { type HermesFileSystem, type HermesProcessRunner, hermesFileSystem, hermesProcess } from './system.ts';
import { executablePath, hermesHostCompilerPath, wasiSdkCompilerPath } from './toolchain-paths.ts';

/** Paths, pins, patches, and injectable dependencies used to prepare Hermes artifacts. */
export interface HermesBuildOptions {
    /** Shared Hermes cache directory for locks and the build-state record. */
    cacheRoot: string;
    /** Environment values that can affect compiler configuration. */
    environment?: NodeJS.ProcessEnv;
    /** Optional filesystem implementation for tests. */
    filesystem?: HermesFileSystem;
    /** Garbage collector compiled into the WASI Hermes libraries; defaults to Hades. */
    gcVariant?: HermesGcVariant;
    /** CMake build directory for the host `hermesc` compiler. */
    hostBuild: string;
    /** Root of the Static Hermes runtime package. */
    packageRoot: string;
    /** Ordered patch series required before compiling Hermes. */
    patches: readonly HermesPatch[];
    /** Validated source pin for this build. */
    pin: HermesSourcePin;
    /** JSON file containing the expected Hermes repository, branch, and commit. */
    pinFile: string;
    /** Host platform override used for platform-specific executable paths and compiler identity. */
    platform?: NodeJS.Platform;
    /** Optional process runner for tests. */
    process?: HermesProcessRunner;
    /** Pinned Hermes source checkout. */
    source: string;
    /** CMake toolchain file used for the WASI build. */
    toolchainFile: string;
    /** CMake build directory for WASI Hermes and JSI libraries. */
    wasiBuild: string;
    /** WASI SDK used by the WASI C and C++ compilers. */
    wasiSdk: string;
}

/** Size and modification time recorded for a prepared Hermes artifact. */
export interface HermesArtifactState {
    /** Modification time in milliseconds since the Unix epoch. */
    mtimeMs: number;
    /** Artifact size in bytes. */
    size: number;
}

interface BuildCacheRecord {
    fingerprint: string;
}

/** Optional mutable resources, dependencies, and timing controls for Hermes preparation locks. */
export interface HermesBuildLockOptions {
    /** Filesystem used to create, read, and remove the lock file. */
    filesystem?: HermesFileSystem;
    /** Process-liveness check used to identify stale owners. */
    isProcessAlive?: (pid: number) => boolean;
    /** Clock used to enforce the timeout. */
    now?: () => number;
    /** Additional mutable Hermes directories that must share this lock with the cache root. */
    resources?: readonly string[];
    /** Maximum wait for another live build to release the lock. */
    timeoutMs?: number;
    /** Delay implementation used between acquisition attempts. */
    wait?: (delayMs: number) => Promise<void>;
}

/**
 * Build or reuse the pinned host compiler and the full/lean WASI Hermes archives.
 *
 * @param options - Pinned source, patch series, build paths, toolchain, and injected dependencies.
 * @throws {Error} If source validation, patch validation, cache locking, or compilation fails.
 */
export async function buildHermes(options: HermesBuildOptions): Promise<void> {
    const filesystem = options.filesystem ?? hermesFileSystem;
    await withHermesBuildLock(options.cacheRoot, () => buildHermesWithLockHeld(options), {
        filesystem,
        resources: [options.source, options.hostBuild, options.wasiBuild],
    });
}

/**
 * Build or reuse Hermes artifacts while the caller holds the shared cache lock.
 *
 * @internal
 * @param options - Pinned source, patch series, build paths, toolchain, and injected dependencies.
 * @throws {Error} If source validation, patch validation, or compilation fails.
 */
export async function buildHermesWithLockHeld(options: HermesBuildOptions): Promise<void> {
    const filesystem = options.filesystem ?? hermesFileSystem;
    const runner = options.process ?? hermesProcess;
    const environment = options.environment ?? process.env;
    const actualCommit = runner.output('git', ['-C', options.source, 'rev-parse', 'HEAD']);
    if (actualCommit !== options.pin.commit) {
        throw new Error(`Hermes build source is ${actualCommit}, expected pinned commit ${options.pin.commit}`);
    }
    ensurePatchOnlyChanges(options.source, options.patches, runner);
    verifyHermesPatchSeriesApplied(options.source, options.patches, runner);

    const gcVariant = options.gcVariant ?? 'hades';
    const buildStatePath = path.join(options.cacheRoot, `prepared-build-${gcVariant}.json`);
    const platform = options.platform ?? process.platform;
    const artifacts = requiredHermesArtifacts(options.hostBuild, options.wasiBuild, platform);
    const fingerprint = hermesBuildFingerprint(options, artifacts, environment, filesystem, runner);
    if (isHermesBuildCacheCurrent(fingerprint, buildStatePath, artifacts, filesystem)) {
        console.log('Hermes build cache is current; skipping rebuild.');
    } else {
        configureAndBuildHermes(options, environment, filesystem, runner);
        const completedFingerprint = hermesBuildFingerprint(options, artifacts, environment, filesystem, runner);
        saveHermesBuildCache(completedFingerprint, buildStatePath, options.cacheRoot, filesystem);
    }
    console.log(`Static Hermes is ready. Source: ${options.source}; WASI 2 libraries: ${options.wasiBuild}`);
}

/**
 * Build a SHA-256 fingerprint from the source checkout, patches, toolchain, CMake commands, and artifacts.
 *
 * @param options - Source, build paths, pin, patches, and injected dependencies.
 * @param requiredArtifacts - Files whose sizes and modification times participate in cache validation; the
 *   host compiler imports file counts by its contents instead.
 * @param environment - Compiler and platform environment values used by the build.
 * @param filesystem - Filesystem implementation used to inspect inputs and artifacts.
 * @param runner - Process runner used to read Git and compiler versions.
 * @returns Hex-encoded fingerprint used to validate the prepared-build cache record.
 */
export function hermesBuildFingerprint(
    options: HermesBuildOptions,
    requiredArtifacts = requiredHermesArtifacts(
        options.hostBuild,
        options.wasiBuild,
        options.platform ?? process.platform,
    ),
    environment = options.environment ?? process.env,
    filesystem: HermesFileSystem = options.filesystem ?? hermesFileSystem,
    runner: HermesProcessRunner = options.process ?? hermesProcess,
): string {
    const platform = options.platform ?? process.platform;
    const hostCompilerImports = path.join(options.hostBuild, 'ImportHostCompilers.cmake');
    const status = runner.output('git', ['-C', options.source, 'status', '--porcelain', '--untracked-files=all']);
    const untrackedFiles = runner
        .output('git', ['-C', options.source, 'ls-files', '--others', '--exclude-standard', '-z'])
        .split('\0')
        .filter(Boolean)
        .map((filename) => [filename, fileDigest(path.join(options.source, filename), filesystem)]);
    const cmakeVersion = runner.output('cmake', ['--version']);
    const inputs = {
        platform,
        schema: 1,
        source: {
            commit: runner.output('git', ['-C', options.source, 'rev-parse', 'HEAD']),
            diff: createHash('sha256')
                .update(runner.buffer('git', ['-C', options.source, 'diff', '--binary', 'HEAD']))
                .digest('hex'),
            status,
            untrackedFiles,
        },
        pin: fileDigest(options.pinFile, filesystem),
        patches: options.patches.map((patch) => [patch.name, fileDigest(patch.filename, filesystem)]),
        toolchainFiles: [
            options.toolchainFile,
            path.join(options.packageRoot, 'toolchain-versions.json'),
            path.join(options.packageRoot, 'wasi-sdk.lock.json'),
        ].map((filename) => [path.relative(options.packageRoot, filename), fileDigest(filename, filesystem)]),
        toolchain: {
            wasiSdk: options.wasiSdk,
            wasiC: runner.output(wasiSdkCompilerPath(options.wasiSdk, 'wasm32-wasip2-clang', platform), ['--version']),
            wasiCxx: runner.output(wasiSdkCompilerPath(options.wasiSdk, 'wasm32-wasip2-clang++', platform), [
                '--version',
            ]),
            hostC: compilerIdentity(
                options.hostBuild,
                'CMAKE_C_COMPILER',
                environment.CC ?? (platform === 'win32' ? 'cl.exe' : 'cc'),
                filesystem,
                runner,
                platform,
                cmakeVersion,
            ),
            hostCxx: compilerIdentity(
                options.hostBuild,
                'CMAKE_CXX_COMPILER',
                environment.CXX ?? (platform === 'win32' ? 'cl.exe' : 'c++'),
                filesystem,
                runner,
                platform,
                cmakeVersion,
            ),
            wasiHostC: compilerIdentity(
                options.wasiBuild,
                'CMAKE_C_COMPILER',
                wasiSdkCompilerPath(options.wasiSdk, 'wasm32-wasip2-clang', platform),
                filesystem,
                runner,
                platform,
                cmakeVersion,
            ),
            wasiHostCxx: compilerIdentity(
                options.wasiBuild,
                'CMAKE_CXX_COMPILER',
                wasiSdkCompilerPath(options.wasiSdk, 'wasm32-wasip2-clang++', platform),
                filesystem,
                runner,
                platform,
                cmakeVersion,
            ),
            cmake: cmakeVersion,
            ninja: runner.output('ninja', ['--version']),
        },
        environment: Object.fromEntries(
            [
                'CC',
                'CXX',
                'CFLAGS',
                'CXXFLAGS',
                'CPPFLAGS',
                'LDFLAGS',
                'SDKROOT',
                'DEVELOPER_DIR',
                'MACOSX_DEPLOYMENT_TARGET',
            ]
                .filter((name) => environment[name] !== undefined)
                .map((name) => [name, environment[name]]),
        ),
        arch: process.arch,
        cmakeCommands: hermesCMakeCommands(options, environment),
        cmakeCaches: [options.hostBuild, options.wasiBuild].map((buildDirectory) => {
            const filename = path.join(buildDirectory, 'CMakeCache.txt');
            return filesystem.existsSync(filename) ? fileDigest(filename, filesystem) : null;
        }),
        artifacts: requiredArtifacts.map((filename) => [
            filename,
            // Each GC variant reconfigures the shared host build, which rewrites this file with the same
            // content, so its mtime would make the variants invalidate each other.
            filename === hostCompilerImports && filesystem.existsSync(filename)
                ? fileDigest(filename, filesystem)
                : artifactState(filename, filesystem),
        ]),
    };
    return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

/**
 * Test an acquired cache fingerprint and all required non-empty output artifacts.
 *
 * @param fingerprint - Expected fingerprint for the current build inputs.
 * @param statePath - Build-state JSON file containing the cached fingerprint.
 * @param artifacts - Required compiler and archive output paths.
 * @param filesystem - Filesystem implementation used to inspect the state and artifacts.
 * @returns `true` only when the cache record matches and every artifact exists with non-zero size.
 */
export function isHermesBuildCacheCurrent(
    fingerprint: string,
    statePath: string,
    artifacts: readonly string[],
    filesystem: HermesFileSystem = hermesFileSystem,
): boolean {
    if (
        artifacts.some((filename) => artifactState(filename, filesystem) === null) ||
        !filesystem.existsSync(statePath)
    ) {
        return false;
    }
    try {
        const record = JSON.parse(filesystem.readFileSync(statePath, 'utf8')) as unknown;
        return isBuildCacheRecord(record) && record.fingerprint === fingerprint;
    } catch {
        return false;
    }
}

/**
 * Persist a validated fingerprint through an atomic cache-state file replacement.
 *
 * @param fingerprint - Fingerprint to record after a successful build.
 * @param statePath - Destination path for the build-state JSON file.
 * @param cacheRoot - Cache directory to create before writing the record.
 * @param filesystem - Filesystem implementation used to write and publish the record.
 */
export function saveHermesBuildCache(
    fingerprint: string,
    statePath: string,
    cacheRoot: string,
    filesystem: HermesFileSystem = hermesFileSystem,
): void {
    filesystem.mkdirSync(cacheRoot, { recursive: true });
    const temporary = `${statePath}.${process.pid}.tmp`;
    filesystem.writeFileSync(temporary, `${JSON.stringify({ fingerprint }, null, 2)}\n`);
    filesystem.renameSync(temporary, statePath);
}

/**
 * Acquire the exclusive preparation lock, removing stale owners and waiting for active builds.
 *
 * @remarks
 * A separate recovery claim serializes stale-owner removal. A claim owned by an exited process is removed only while
 * its file identity and contents still match the stale claim that was inspected.
 *
 * @param lockPath - Path to the lock file created with exclusive-write semantics.
 * @param options - Optional filesystem, timeout, clock, wait, and process-liveness hooks.
 * @returns A unique token identifying this lock owner.
 * @throws {Error} If the lock cannot be acquired before the configured timeout.
 */
export async function acquireHermesBuildLock(lockPath: string, options: HermesBuildLockOptions = {}): Promise<string> {
    const filesystem = options.filesystem ?? hermesFileSystem;
    const timeoutMs = options.timeoutMs ?? 30 * 60_000;
    const wait = options.wait ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
    const now = options.now ?? Date.now;
    const isProcessAlive = options.isProcessAlive ?? processIsAlive;
    const ownerToken = randomUUID();
    const reclaimLockPath = `${lockPath}.reclaim`;
    filesystem.mkdirSync(path.dirname(lockPath), { recursive: true });
    const deadline = now() + timeoutMs;
    while (true) {
        try {
            writeHermesLock(lockPath, ownerToken, now(), filesystem);
            return ownerToken;
        } catch (error) {
            if (errorCode(error) !== 'EEXIST') throw error;
            if (staleHermesBuildLock(lockPath, filesystem, now, isProcessAlive)) {
                const reclaimToken = tryAcquireHermesReclaimLock(reclaimLockPath, now, isProcessAlive, filesystem);
                if (reclaimToken !== null) {
                    try {
                        if (staleHermesBuildLock(lockPath, filesystem, now, isProcessAlive)) {
                            filesystem.rmSync(lockPath, { force: true });
                            try {
                                writeHermesLock(lockPath, ownerToken, now(), filesystem);
                                return ownerToken;
                            } catch (writeError) {
                                if (errorCode(writeError) !== 'EEXIST') throw writeError;
                            }
                        }
                    } finally {
                        releaseHermesBuildLock(reclaimLockPath, reclaimToken, filesystem);
                    }
                    continue;
                }
            }
            if (now() >= deadline) {
                if (filesystem.existsSync(reclaimLockPath)) {
                    throw new Error(
                        `Timed out waiting for Hermes build lock: ${lockPath}; inspect recovery claim ${reclaimLockPath} and remove it only after confirming no recovery is active`,
                    );
                }
                throw new Error(`Timed out waiting for Hermes build lock: ${lockPath}`);
            }
            await wait(250);
        }
    }
}

function tryAcquireHermesReclaimLock(
    lockPath: string,
    now: () => number,
    isProcessAlive: (pid: number) => boolean,
    filesystem: HermesFileSystem,
): string | null {
    const ownerToken = randomUUID();
    try {
        writeHermesLock(lockPath, ownerToken, now(), filesystem);
        return ownerToken;
    } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        if (!removeStaleHermesReclaimLock(lockPath, now, isProcessAlive, filesystem)) return null;
        try {
            writeHermesLock(lockPath, ownerToken, now(), filesystem);
            return ownerToken;
        } catch (writeError) {
            if (errorCode(writeError) === 'EEXIST') return null;
            throw writeError;
        }
    }
}

function removeStaleHermesReclaimLock(
    lockPath: string,
    now: () => number,
    isProcessAlive: (pid: number) => boolean,
    filesystem: HermesFileSystem,
): boolean {
    let originalFile: fs.Stats;
    try {
        originalFile = filesystem.lstatSync(lockPath);
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return true;
        throw error;
    }

    let originalContents: string;
    try {
        originalContents = filesystem.readFileSync(lockPath, 'utf8');
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return true;
        throw error;
    }
    if (!staleHermesBuildLock(lockPath, filesystem, now, isProcessAlive)) return false;

    let currentFile: fs.Stats;
    try {
        currentFile = filesystem.lstatSync(lockPath);
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return true;
        throw error;
    }
    if (!sameHermesLockFile(originalFile, currentFile)) return false;

    let currentContents: string;
    try {
        currentContents = filesystem.readFileSync(lockPath, 'utf8');
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return true;
        throw error;
    }
    if (currentContents !== originalContents || !staleHermesBuildLock(lockPath, filesystem, now, isProcessAlive)) {
        return false;
    }

    filesystem.rmSync(lockPath, { force: true });
    return true;
}

function writeHermesLock(lockPath: string, ownerToken: string, startedAt: number, filesystem: HermesFileSystem): void {
    const descriptor = filesystem.openSync(lockPath, 'wx');
    let createdFile: fs.Stats;
    try {
        createdFile = filesystem.fstatSync(descriptor);
    } catch (error) {
        filesystem.closeSync(descriptor);
        throw error;
    }

    let failure: unknown;
    let failed = false;
    try {
        filesystem.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, startedAt, token: ownerToken })}\n`);
    } catch (error) {
        failure = error;
        failed = true;
    }
    try {
        filesystem.closeSync(descriptor);
    } catch (error) {
        if (!failed) {
            failure = error;
            failed = true;
        }
    }

    if (!failed) return;
    try {
        removeIncompleteHermesLock(lockPath, ownerToken, createdFile, filesystem);
    } catch (cleanupError) {
        throw new AggregateError(
            [failure, cleanupError],
            `Failed to write and clean up Hermes build lock: ${lockPath}`,
        );
    }
    throw failure;
}

/** Remove an incomplete lock only while its original file identity and owner token still match. */
function removeIncompleteHermesLock(
    lockPath: string,
    ownerToken: string,
    createdFile: fs.Stats,
    filesystem: HermesFileSystem,
): void {
    let currentFile: fs.Stats;
    try {
        currentFile = filesystem.lstatSync(lockPath);
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return;
        throw error;
    }
    if (!sameHermesLockFile(createdFile, currentFile)) return;

    let currentContents: string;
    try {
        currentContents = filesystem.readFileSync(lockPath, 'utf8');
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return;
        throw error;
    }

    let owner: unknown;
    try {
        owner = JSON.parse(currentContents) as unknown;
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
    }
    if (typeof owner === 'object' && owner !== null && 'token' in owner && owner.token !== ownerToken) return;

    try {
        currentFile = filesystem.lstatSync(lockPath);
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return;
        throw error;
    }
    if (sameHermesLockFile(createdFile, currentFile)) filesystem.rmSync(lockPath, { force: true });
}

/** Compare file device and inode values to identify one lock-file entry. */
function sameHermesLockFile(left: fs.Stats, right: fs.Stats): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Run a cache operation while holding exclusive locks for the cache root and mutable Hermes directories.
 *
 * @template T - Result returned by the locked operation
 * @param cacheRoot - Shared cache root that contains the build-state record.
 * @param operation - Source, patch, and build work that must be serialized.
 * @param options - Optional mutable resource paths, filesystem, and lock-wait controls.
 * @returns The result of the locked operation.
 * @throws {Error} If the lock cannot be acquired or the operation fails.
 */
export async function withHermesBuildLock<T>(
    cacheRoot: string,
    operation: () => T | Promise<T>,
    options: HermesBuildLockOptions = {},
): Promise<T> {
    const filesystem = options.filesystem ?? hermesFileSystem;
    const canonicalCacheRoot = canonicalHermesResourcePath(cacheRoot);
    const lockPaths = [
        path.join(canonicalCacheRoot, 'prepare.lock'),
        ...[cacheRoot, ...(options.resources ?? [])].map(hermesResourceLockPath),
    ]
        .filter((lockPath, index, allLockPaths) => allLockPaths.indexOf(lockPath) === index)
        .sort();
    const owners: Array<{ lockPath: string; ownerToken: string }> = [];
    try {
        for (const lockPath of lockPaths) {
            owners.push({ lockPath, ownerToken: await acquireHermesBuildLock(lockPath, options) });
        }
        return await operation();
    } finally {
        for (const { lockPath, ownerToken } of owners.reverse()) {
            releaseHermesBuildLock(lockPath, ownerToken, filesystem);
        }
    }
}

/**
 * Return the stable lock file path for a mutable Hermes directory.
 *
 * @param resourcePath - Directory whose concurrent mutations must be serialized.
 * @returns Lock file path shared by callers that resolve to the same directory.
 */
function hermesResourceLockPath(resourcePath: string): string {
    const canonicalPath = canonicalHermesResourcePath(resourcePath);
    const identity =
        process.platform === 'win32' || process.platform === 'darwin' ? canonicalPath.toLowerCase() : canonicalPath;
    const lockName = createHash('sha256').update(identity).digest('hex');
    return path.join(path.dirname(canonicalPath), '.static-hermes-locks', `${lockName}.lock`);
}

/**
 * Resolve existing path components and retain any missing suffix for a directory that will be created later.
 *
 * @param resourcePath - Directory path to canonicalize.
 * @returns Absolute path with existing symbolic links resolved.
 * @throws {Error} If an existing path component cannot be read.
 */
function canonicalHermesResourcePath(resourcePath: string): string {
    const absolutePath = path.resolve(resourcePath);
    try {
        return fs.realpathSync(absolutePath);
    } catch (error) {
        if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') throw error;
        const parentPath = path.dirname(absolutePath);
        if (parentPath === absolutePath) return absolutePath;
        return path.join(canonicalHermesResourcePath(parentPath), path.basename(absolutePath));
    }
}

function releaseHermesBuildLock(lockPath: string, ownerToken: string, filesystem: HermesFileSystem): void {
    let contents: string;
    try {
        contents = filesystem.readFileSync(lockPath, 'utf8');
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return;
        throw error;
    }
    let owner: unknown;
    try {
        owner = JSON.parse(contents) as unknown;
    } catch (error) {
        if (error instanceof SyntaxError) return;
        throw error;
    }
    if (typeof owner !== 'object' || owner === null || !('token' in owner) || owner.token !== ownerToken) return;
    filesystem.rmSync(lockPath, { force: true });
}

/**
 * Check whether a lock file has no live owner or has exceeded its fallback age.
 *
 * @remarks
 * A valid lock is stale when its process is gone. Malformed lock files are treated as stale after 60 seconds.
 *
 * @param lockPath - Path to the lock file to inspect.
 * @param filesystem - Filesystem used to inspect and read the lock.
 * @param now - Clock used to compare malformed lock-file age.
 * @param isProcessAlive - Process-liveness check for a valid lock owner.
 */
export function staleHermesBuildLock(
    lockPath: string,
    filesystem: HermesFileSystem = hermesFileSystem,
    now: () => number = Date.now,
    isProcessAlive: (pid: number) => boolean = processIsAlive,
): boolean {
    let stat: ReturnType<HermesFileSystem['statSync']>;
    try {
        stat = filesystem.statSync(lockPath);
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return true;
        throw error;
    }
    try {
        const owner = JSON.parse(filesystem.readFileSync(lockPath, 'utf8')) as unknown;
        if (typeof owner === 'object' && owner !== null && 'pid' in owner) {
            const pid = owner.pid;
            if (Number.isInteger(pid) && typeof pid === 'number' && pid > 0) return !isProcessAlive(pid);
        }
    } catch (error) {
        if (!(error instanceof SyntaxError)) {
            if (errorCode(error) === 'ENOENT') return true;
            throw error;
        }
    }
    return now() - stat.mtimeMs > 60_000;
}

/**
 * Return the files required for a reusable Hermes build, using host executable names.
 *
 * @param hostBuild - Host CMake build directory.
 * @param wasiBuild - WASI CMake build directory.
 * @param platform - Host platform; defaults to the current process platform.
 * @returns Required host compiler, imported compiler metadata, and WASI archives.
 */
export function requiredHermesArtifacts(
    hostBuild: string,
    wasiBuild: string,
    platform: NodeJS.Platform = process.platform,
): string[] {
    return [
        path.join(hostBuild, 'ImportHostCompilers.cmake'),
        executablePath(path.join(hostBuild, 'bin'), 'shermes', platform),
        hermesHostCompilerPath(hostBuild, platform),
        path.join(wasiBuild, 'lib/libhermesvm_a.a'),
        path.join(wasiBuild, 'lib/libhermesvmlean_a.a'),
        path.join(wasiBuild, 'jsi/libjsi.a'),
    ];
}

/**
 * Return the CMake argument lists that configure and build the host compiler and the WASI archives, in run order.
 *
 * @remarks
 * The build fingerprint hashes these lists, so every build setting that reaches CMake invalidates the cache.
 *
 * @param options - Source, build directories, toolchain, platform, and garbage collector for the build.
 * @param environment - Environment flags that select optional Hermes features.
 * @returns Argument lists for `cmake`: host configure, host build, WASI configure, WASI build.
 */
export function hermesCMakeCommands(options: HermesBuildOptions, environment: NodeJS.ProcessEnv): string[][] {
    const hostPlatform = options.platform ?? process.platform;
    const hostCxxReleaseFlags = hostPlatform === 'win32' ? '-Os -DNDEBUG' : '-Os -DNDEBUG -Wno-unused-template';
    const jsiExtensions = environment.STATIC_HERMES_ENABLE_JSI_EXTENSIONS === '1' ? 'ON' : 'OFF';
    return [
        [
            '-S',
            options.source,
            '-B',
            options.hostBuild,
            '-G',
            'Ninja',
            '-DCMAKE_BUILD_TYPE=Release',
            '-DHERMES_ENABLE_TOOLS=ON',
            '-DHERMES_ENABLE_NAPI=OFF',
            '-DHERMES_ENABLE_TEST_SUITE=OFF',
            '-DHERMES_BUILD_SHARED_JSI=OFF',
            '-DHERMESVM_ALLOW_JIT=0',
            '-DHERMES_UNICODE_LITE=ON',
            '-DHERMES_ALLOW_BOOST_CONTEXT=0',
            '-DCMAKE_C_FLAGS_RELEASE=-Os -DNDEBUG',
            `-DCMAKE_CXX_FLAGS_RELEASE=${hostCxxReleaseFlags}`,
        ],
        ['--build', options.hostBuild, '--target', 'shermes', 'hermesc', '--parallel'],
        [
            '-S',
            options.source,
            '-B',
            options.wasiBuild,
            '-G',
            'Ninja',
            '-DCMAKE_BUILD_TYPE=MinSizeRel',
            `-DCMAKE_TOOLCHAIN_FILE=${options.toolchainFile}`,
            // Patch 0001 reads this before project(), when CMAKE_SYSTEM_NAME is not set yet.
            '-DHERMES_WASI_TARGET=ON',
            `-DWASI_SDK_PREFIX=${options.wasiSdk}`,
            `-DIMPORT_HOST_COMPILERS=${path.join(options.hostBuild, 'ImportHostCompilers.cmake')}`,
            '-DCMAKE_C_FLAGS_MINSIZEREL=-Oz -DNDEBUG -ffunction-sections -fdata-sections',
            '-DCMAKE_CXX_FLAGS_MINSIZEREL=-Oz -DNDEBUG -ffunction-sections -fdata-sections -Wno-unused-template',
            '-DCMAKE_C_FLAGS=-mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false',
            '-DCMAKE_CXX_FLAGS=-mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS',
            '-DHERMES_ENABLE_TOOLS=OFF',
            '-DHERMES_ENABLE_TEST_SUITE=OFF',
            '-DHERMES_ENABLE_NAPI=OFF',
            '-DHERMES_ENABLE_DEBUGGER=OFF',
            '-DHERMES_ENABLE_INTL=OFF',
            `-DHERMES_ENABLE_CORE_EXTENSIONS=${jsiExtensions}`,
            `-DHERMES_ENABLE_CONTRIB_EXTENSIONS=${jsiExtensions}`,
            `-DHERMES_ENABLE_UNICODE_REGEXP_PROPERTY_ESCAPES=${environment.STATIC_HERMES_ENABLE_UNICODE_REGEXP_PROPERTY_ESCAPES === '0' ? 'OFF' : 'ON'}`,
            '-DHERMES_BUILD_SHARED_JSI=OFF',
            '-DHERMES_CHECK_NATIVE_STACK=ON',
            '-DHERMESVM_ALLOW_JIT=0',
            '-DHERMES_UNICODE_LITE=ON',
            '-DHERMES_ALLOW_BOOST_CONTEXT=0',
            `-DHERMESVM_GCKIND=${(options.gcVariant ?? 'hades').toUpperCase()}`,
        ],
        ['--build', options.wasiBuild, '--target', 'hermesvm_a', 'hermesvmlean_a', 'jsi', '--parallel'],
    ];
}

function configureAndBuildHermes(
    options: HermesBuildOptions,
    environment: NodeJS.ProcessEnv,
    filesystem: HermesFileSystem,
    runner: HermesProcessRunner,
): void {
    ensureLibcxxIncludeMarker(options.wasiSdk, filesystem);
    filesystem.mkdirSync(options.hostBuild, { recursive: true });
    filesystem.mkdirSync(options.wasiBuild, { recursive: true });
    if (!filesystem.existsSync(options.toolchainFile)) {
        throw new Error(`WASI 2 Hermes toolchain file not found: ${options.toolchainFile}`);
    }
    for (const args of hermesCMakeCommands(options, environment)) runner.run('cmake', args);
}

/**
 * Create the empty `include/c++/v1` directory in the WASI sysroot when it is missing.
 *
 * wasi-sdk 34 stores WASI libc++ headers under target-specific paths. Its Clang driver enables those paths only when
 * this otherwise-empty marker exists. A read-only SDK that already has it is left untouched.
 */
function ensureLibcxxIncludeMarker(wasiSdk: string, filesystem: HermesFileSystem): void {
    const marker = path.join(wasiSdk, 'share/wasi-sysroot/include/c++/v1');
    if (filesystem.existsSync(marker)) return;
    try {
        filesystem.mkdirSync(marker, { recursive: true });
    } catch (error) {
        if (!['EACCES', 'EPERM', 'EROFS'].includes(errorCode(error) ?? '')) throw error;
        throw new Error(
            `Cannot create ${marker}: clang in wasi-sdk needs this empty directory to find the WASI libc++ headers. Create it once with write access to the SDK, or point STATIC_HERMES_WASI_SDK_PATH at a writable copy.`,
            { cause: error },
        );
    }
}

/** Determine the configured compiler command and a stable identity for cache keys.
 *
 * @param buildDirectory - CMake build directory containing compiler configuration.
 * @param cacheKey - CMake variable name for the compiler, such as `CMAKE_C_COMPILER`.
 * @param fallback - Compiler command to use when CMake has not recorded one.
 * @param filesystem - Filesystem used to read CMake's cache and generated metadata.
 * @param runner - Process runner used to query compiler versions.
 * @param platform - Host platform used to handle MSVC without shelling out to `cl.exe`.
 * @param cmakeVersion - CMake version used to locate the active compiler metadata file.
 * @returns The compiler command and version string used in the build fingerprint.
 */
function compilerIdentity(
    buildDirectory: string,
    cacheKey: string,
    fallback: string,
    filesystem: HermesFileSystem,
    runner: HermesProcessRunner,
    platform: NodeJS.Platform,
    cmakeVersion: string,
): { command: string; version: string } {
    const cache = path.join(buildDirectory, 'CMakeCache.txt');
    const cacheText = filesystem.existsSync(cache) ? filesystem.readFileSync(cache, 'utf8') : '';
    const cachedCompiler = cacheText.match(new RegExp(`^${cacheKey}:[^=]+=([^\\n]+)$`, 'm'))?.[1];
    const command = cachedCompiler ?? fallback;
    const metadata = compilerMetadata(buildDirectory, cacheKey, cacheText, filesystem, cmakeVersion);
    if (cachedCompiler && metadata.id && metadata.version) {
        return { command, version: `${metadata.id} ${metadata.version}` };
    }
    if (platform === 'win32' && /^cl(?:\.exe)?$/i.test(path.basename(command))) {
        return { command, version: 'MSVC compiler identity recorded by CMake after configuration' };
    }
    return { command, version: runner.output(command, ['--version']) };
}

/** Read compiler ID and version from CMake's cache or generated compiler metadata.
 *
 * @param buildDirectory - CMake build directory containing the cache and generated metadata.
 * @param cacheKey - CMake compiler variable whose ID and version are required.
 * @param cacheText - Contents of the CMake cache, if one exists.
 * @param filesystem - Filesystem used to inspect and read generated metadata.
 * @param cmakeVersion - CMake version used to prefer its matching metadata directory.
 * @returns Available compiler ID and version values.
 */
function compilerMetadata(
    buildDirectory: string,
    cacheKey: string,
    cacheText: string,
    filesystem: HermesFileSystem,
    cmakeVersion: string,
): { id?: string; version?: string } {
    let id = cacheText.match(new RegExp(`^${cacheKey}_ID:[^=]+=([^\\r\\n]+)$`, 'm'))?.[1];
    let version = cacheText.match(new RegExp(`^${cacheKey}_VERSION:[^=]+=([^\\r\\n]+)$`, 'm'))?.[1];
    if (id && version) return { id, version };

    const compilerFile = cacheKey === 'CMAKE_C_COMPILER' ? 'CMakeCCompiler.cmake' : 'CMakeCXXCompiler.cmake';
    const cmakeFilesDirectory = path.join(buildDirectory, 'CMakeFiles');
    if (!filesystem.existsSync(cmakeFilesDirectory)) return { id, version };

    const directories = filesystem.readdirSync(cmakeFilesDirectory).sort();
    const activeCMakeVersion = cmakeVersion.match(/\bcmake version\s+([\d.]+)/i)?.[1];
    const orderedDirectories = activeCMakeVersion ? [activeCMakeVersion] : directories;
    for (const versionDirectory of orderedDirectories) {
        const filename = path.join(cmakeFilesDirectory, versionDirectory, compilerFile);
        if (!filesystem.existsSync(filename)) continue;
        const metadataText = filesystem.readFileSync(filename, 'utf8');
        id ??= cmakeSetValue(metadataText, `${cacheKey}_ID`);
        version ??= cmakeSetValue(metadataText, `${cacheKey}_VERSION`);
        if (id && version) return { id, version };
    }
    return { id, version };
}

/** Extract a quoted `set(NAME "value")` assignment from a CMake compiler file.
 *
 * @param source - CMake file contents to search.
 * @param name - Variable name assigned by the CMake file.
 * @returns The assigned value, or `undefined` when no matching assignment exists.
 */
function cmakeSetValue(source: string, name: string): string | undefined {
    return source.match(new RegExp(`^set\\(${name} "([^"]*)"\\)$`, 'm'))?.[1];
}

function artifactState(filename: string, filesystem: HermesFileSystem): HermesArtifactState | null {
    if (!filesystem.existsSync(filename)) return null;
    const stat = filesystem.statSync(filename);
    if (!stat.isFile() || stat.size === 0) return null;
    return { size: stat.size, mtimeMs: stat.mtimeMs };
}

function fileDigest(filename: string, filesystem: HermesFileSystem): string {
    return createHash('sha256').update(filesystem.readFileSync(filename)).digest('hex');
}

function isBuildCacheRecord(value: unknown): value is BuildCacheRecord {
    return (
        typeof value === 'object' &&
        value !== null &&
        'fingerprint' in value &&
        typeof value.fingerprint === 'string' &&
        /^[a-f0-9]{64}$/.test(value.fingerprint)
    );
}

function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return errorCode(error) === 'EPERM';
    }
}

function errorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
    return typeof error.code === 'string' ? error.code : undefined;
}
