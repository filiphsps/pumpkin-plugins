import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { ensurePatchOnlyChanges, type HermesPatch, verifyHermesPatchSeriesApplied } from './patch.ts';
import type { HermesSourcePin } from './source.ts';
import { type HermesFileSystem, type HermesProcessRunner, hermesFileSystem, hermesProcess } from './system.ts';

/** Paths, pins, patches, and injectable dependencies used to prepare Hermes artifacts. */
export interface HermesBuildOptions {
    /** Root of the Static Hermes runtime package. */
    packageRoot: string;
    /** Shared Hermes cache directory for locks and the build-state record. */
    cacheRoot: string;
    /** Pinned Hermes source checkout. */
    source: string;
    /** CMake build directory for the host `hermesc` compiler. */
    hostBuild: string;
    /** CMake build directory for WASI Hermes and JSI libraries. */
    wasiBuild: string;
    /** WASI SDK used by the WASI C and C++ compilers. */
    wasiSdk: string;
    /** CMake toolchain file used for the WASI build. */
    toolchainFile: string;
    /** JSON file containing the expected Hermes repository, branch, and commit. */
    pinFile: string;
    /** Validated source pin for this build. */
    pin: HermesSourcePin;
    /** Ordered patch series required before compiling Hermes. */
    patches: readonly HermesPatch[];
    /** Environment values that can affect compiler configuration. */
    environment?: NodeJS.ProcessEnv;
    /** Optional filesystem implementation for tests. */
    filesystem?: HermesFileSystem;
    /** Optional process runner for tests. */
    process?: HermesProcessRunner;
}

/** Size and modification time recorded for a prepared Hermes artifact. */
export interface HermesArtifactState {
    /** Artifact size in bytes. */
    size: number;
    /** Modification time in milliseconds since the Unix epoch. */
    mtimeMs: number;
}

interface BuildCacheRecord {
    fingerprint: string;
}

/**
 * Build or reuse the pinned host compiler and the full/lean WASI Hermes archives.
 *
 * @param options - Pinned source, patch series, build paths, toolchain, and injected dependencies.
 * @throws {Error} If source validation, patch validation, cache locking, or compilation fails.
 */
export async function buildHermes(options: HermesBuildOptions): Promise<void> {
    const filesystem = options.filesystem ?? hermesFileSystem;
    const runner = options.process ?? hermesProcess;
    const environment = options.environment ?? process.env;
    const actualCommit = runner.output('git', ['-C', options.source, 'rev-parse', 'HEAD']);
    if (actualCommit !== options.pin.commit) {
        throw new Error(`Hermes build source is ${actualCommit}, expected pinned commit ${options.pin.commit}`);
    }
    ensurePatchOnlyChanges(options.source, options.patches, runner);
    verifyHermesPatchSeriesApplied(options.source, options.patches, runner);

    const buildStatePath = path.join(options.cacheRoot, 'prepared-build.json');
    const buildLockPath = path.join(options.cacheRoot, 'prepare.lock');
    const artifacts = requiredHermesArtifacts(options.hostBuild, options.wasiBuild);
    await acquireHermesBuildLock(buildLockPath, { filesystem });
    try {
        const fingerprint = hermesBuildFingerprint(options, artifacts, environment, filesystem, runner);
        if (isHermesBuildCacheCurrent(fingerprint, buildStatePath, artifacts, filesystem)) {
            console.log('Hermes build cache is current; skipping rebuild.');
        } else {
            configureAndBuildHermes(options, environment, filesystem, runner);
            const completedFingerprint = hermesBuildFingerprint(options, artifacts, environment, filesystem, runner);
            saveHermesBuildCache(completedFingerprint, buildStatePath, options.cacheRoot, filesystem);
        }
    } finally {
        filesystem.rmSync(buildLockPath, { force: true });
    }
    console.log(`Static Hermes is ready. Source: ${options.source}; WASI 2 libraries: ${options.wasiBuild}`);
}

/**
 * Build a SHA-256 fingerprint from the source checkout, patches, toolchain, build configuration, and artifacts.
 *
 * @param options - Source, build paths, pin, patches, and injected dependencies.
 * @param requiredArtifacts - Files whose sizes and modification times participate in cache validation.
 * @param environment - Compiler and platform environment values used by the build.
 * @param filesystem - Filesystem implementation used to inspect inputs and artifacts.
 * @param runner - Process runner used to read Git and compiler versions.
 * @returns Hex-encoded fingerprint used to validate the prepared-build cache record.
 */
export function hermesBuildFingerprint(
    options: HermesBuildOptions,
    requiredArtifacts = requiredHermesArtifacts(options.hostBuild, options.wasiBuild),
    environment = options.environment ?? process.env,
    filesystem: HermesFileSystem = options.filesystem ?? hermesFileSystem,
    runner: HermesProcessRunner = options.process ?? hermesProcess
): string {
    const status = runner.output('git', ['-C', options.source, 'status', '--porcelain', '--untracked-files=all']);
    const untrackedFiles = runner
        .output('git', ['-C', options.source, 'ls-files', '--others', '--exclude-standard', '-z'])
        .split('\0')
        .filter(Boolean)
        .map((filename) => [filename, fileDigest(path.join(options.source, filename), filesystem)]);
    const moduleFiles = [
        ...filesystem
            .readdirSync(path.join(options.packageRoot, 'src/hermes'))
            .filter((filename) => filename.endsWith('.ts'))
            .map((filename) => path.join(options.packageRoot, 'src/hermes', filename)),
        path.join(options.packageRoot, 'src/cli.ts'),
        path.join(options.packageRoot, 'src/hermes/toolchain-environment.ts')
    ].filter((filename) => filesystem.existsSync(filename));
    const inputs = {
        schema: 1,
        source: {
            commit: runner.output('git', ['-C', options.source, 'rev-parse', 'HEAD']),
            diff: createHash('sha256')
                .update(runner.buffer('git', ['-C', options.source, 'diff', '--binary', 'HEAD']))
                .digest('hex'),
            status,
            untrackedFiles
        },
        pin: fileDigest(options.pinFile, filesystem),
        patches: options.patches.map((patch) => [patch.name, fileDigest(patch.filename, filesystem)]),
        buildModules: moduleFiles.map((filename) => [
            path.relative(options.packageRoot, filename),
            fileDigest(filename, filesystem)
        ]),
        toolchainFiles: [
            options.toolchainFile,
            path.join(options.packageRoot, 'toolchain-versions.json'),
            path.join(options.packageRoot, 'wasi-sdk.json')
        ].map((filename) => [path.relative(options.packageRoot, filename), fileDigest(filename, filesystem)]),
        toolchain: {
            wasiSdk: options.wasiSdk,
            wasiC: runner.output(path.join(options.wasiSdk, 'bin/wasm32-wasip2-clang'), ['--version']),
            wasiCxx: runner.output(path.join(options.wasiSdk, 'bin/wasm32-wasip2-clang++'), ['--version']),
            hostC: compilerIdentity(options.hostBuild, 'CMAKE_C_COMPILER', environment.CC ?? 'cc', filesystem, runner),
            hostCxx: compilerIdentity(
                options.hostBuild,
                'CMAKE_CXX_COMPILER',
                environment.CXX ?? 'c++',
                filesystem,
                runner
            ),
            wasiHostC: compilerIdentity(
                options.wasiBuild,
                'CMAKE_C_COMPILER',
                path.join(options.wasiSdk, 'bin/wasm32-wasip2-clang'),
                filesystem,
                runner
            ),
            wasiHostCxx: compilerIdentity(
                options.wasiBuild,
                'CMAKE_CXX_COMPILER',
                path.join(options.wasiSdk, 'bin/wasm32-wasip2-clang++'),
                filesystem,
                runner
            ),
            cmake: runner.output('cmake', ['--version']),
            ninja: runner.output('ninja', ['--version'])
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
                'MACOSX_DEPLOYMENT_TARGET'
            ]
                .filter((name) => environment[name] !== undefined)
                .map((name) => [name, environment[name]])
        ),
        options: {
            platform: process.platform,
            arch: process.arch,
            source: options.source,
            hostBuild: options.hostBuild,
            wasiBuild: options.wasiBuild,
            enableJsiExtensions: environment.STATIC_HERMES_ENABLE_JSI_EXTENSIONS === '1',
            enableUnicodeRegexpPropertyEscapes: environment.STATIC_HERMES_ENABLE_UNICODE_REGEXP_PROPERTY_ESCAPES !== '0'
        },
        cmakeCaches: [options.hostBuild, options.wasiBuild].map((buildDirectory) => {
            const filename = path.join(buildDirectory, 'CMakeCache.txt');
            return filesystem.existsSync(filename) ? fileDigest(filename, filesystem) : null;
        }),
        artifacts: requiredArtifacts.map((filename) => [filename, artifactState(filename, filesystem)])
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
    filesystem: HermesFileSystem = hermesFileSystem
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
    filesystem: HermesFileSystem = hermesFileSystem
): void {
    filesystem.mkdirSync(cacheRoot, { recursive: true });
    const temporary = `${statePath}.${process.pid}.tmp`;
    filesystem.writeFileSync(temporary, `${JSON.stringify({ fingerprint }, null, 2)}\n`);
    filesystem.renameSync(temporary, statePath);
}

/**
 * Acquire the exclusive preparation lock, removing stale owners and waiting for active builds.
 *
 * @param lockPath - Path to the lock file created with exclusive-write semantics.
 * @param options - Optional filesystem, timeout, clock, wait, and process-liveness hooks.
 * @throws {Error} If the lock cannot be acquired before the configured timeout.
 */
export async function acquireHermesBuildLock(
    lockPath: string,
    options: {
        /** Filesystem used to create, read, and remove the lock file. */
        filesystem?: HermesFileSystem;
        /** Maximum wait for another live build to release the lock. */
        timeoutMs?: number;
        /** Delay implementation used between acquisition attempts. */
        wait?: (delayMs: number) => Promise<void>;
        /** Clock used to enforce the timeout. */
        now?: () => number;
        /** Process-liveness check used to identify stale owners. */
        isProcessAlive?: (pid: number) => boolean;
    } = {}
): Promise<void> {
    const filesystem = options.filesystem ?? hermesFileSystem;
    const timeoutMs = options.timeoutMs ?? 30 * 60_000;
    const wait = options.wait ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
    const now = options.now ?? Date.now;
    const isProcessAlive = options.isProcessAlive ?? processIsAlive;
    filesystem.mkdirSync(path.dirname(lockPath), { recursive: true });
    const deadline = now() + timeoutMs;
    while (true) {
        try {
            filesystem.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, startedAt: now() })}\n`, {
                flag: 'wx'
            });
            return;
        } catch (error) {
            if (errorCode(error) !== 'EEXIST') throw error;
            if (staleHermesBuildLock(lockPath, filesystem, now, isProcessAlive)) {
                filesystem.rmSync(lockPath, { force: true });
                continue;
            }
            if (now() >= deadline) throw new Error(`Timed out waiting for Hermes build lock: ${lockPath}`);
            await wait(250);
        }
    }
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
    isProcessAlive: (pid: number) => boolean = processIsAlive
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

function requiredHermesArtifacts(hostBuild: string, wasiBuild: string): string[] {
    return [
        path.join(hostBuild, 'ImportHostCompilers.cmake'),
        path.join(hostBuild, 'bin/shermes'),
        path.join(hostBuild, 'bin/hermesc'),
        path.join(wasiBuild, 'lib/libhermesvm_a.a'),
        path.join(wasiBuild, 'lib/libhermesvmlean_a.a'),
        path.join(wasiBuild, 'jsi/libjsi.a')
    ];
}

function configureAndBuildHermes(
    options: HermesBuildOptions,
    environment: NodeJS.ProcessEnv,
    filesystem: HermesFileSystem,
    runner: HermesProcessRunner
): void {
    filesystem.mkdirSync(path.join(options.wasiSdk, 'share/wasi-sysroot/include/c++/v1'), { recursive: true });
    filesystem.mkdirSync(options.hostBuild, { recursive: true });
    filesystem.mkdirSync(options.wasiBuild, { recursive: true });
    if (!filesystem.existsSync(options.toolchainFile)) {
        throw new Error(`WASI 2 Hermes toolchain file not found: ${options.toolchainFile}`);
    }

    runner.run('cmake', [
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
        '-DCMAKE_CXX_FLAGS_RELEASE=-Os -DNDEBUG -Wno-unused-template'
    ]);
    runner.run('cmake', ['--build', options.hostBuild, '--target', 'shermes', 'hermesc', '--parallel']);
    runner.run('cmake', [
        '-S',
        options.source,
        '-B',
        options.wasiBuild,
        '-G',
        'Ninja',
        '-DCMAKE_BUILD_TYPE=MinSizeRel',
        `-DCMAKE_TOOLCHAIN_FILE=${options.toolchainFile}`,
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
        `-DHERMES_ENABLE_CORE_EXTENSIONS=${environment.STATIC_HERMES_ENABLE_JSI_EXTENSIONS === '1' ? 'ON' : 'OFF'}`,
        `-DHERMES_ENABLE_CONTRIB_EXTENSIONS=${environment.STATIC_HERMES_ENABLE_JSI_EXTENSIONS === '1' ? 'ON' : 'OFF'}`,
        `-DHERMES_ENABLE_UNICODE_REGEXP_PROPERTY_ESCAPES=${environment.STATIC_HERMES_ENABLE_UNICODE_REGEXP_PROPERTY_ESCAPES === '0' ? 'OFF' : 'ON'}`,
        '-DHERMES_BUILD_SHARED_JSI=OFF',
        '-DHERMES_CHECK_NATIVE_STACK=ON',
        '-DHERMESVM_ALLOW_JIT=0',
        '-DHERMES_UNICODE_LITE=ON',
        '-DHERMES_ALLOW_BOOST_CONTEXT=0',
        '-DHERMESVM_GCKIND=MALLOC'
    ]);
    runner.run('cmake', [
        '--build',
        options.wasiBuild,
        '--target',
        'hermesvm_a',
        'hermesvmlean_a',
        'jsi',
        '--parallel'
    ]);
}

function compilerIdentity(
    buildDirectory: string,
    cacheKey: string,
    fallback: string,
    filesystem: HermesFileSystem,
    runner: HermesProcessRunner
): { command: string; version: string } {
    const cache = path.join(buildDirectory, 'CMakeCache.txt');
    const cacheText = filesystem.existsSync(cache) ? filesystem.readFileSync(cache, 'utf8') : '';
    const cachedCompiler = cacheText.match(new RegExp(`^${cacheKey}:[^=]+=([^\\n]+)$`, 'm'))?.[1];
    const command = cachedCompiler ?? fallback;
    return { command, version: runner.output(command, ['--version']) };
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
