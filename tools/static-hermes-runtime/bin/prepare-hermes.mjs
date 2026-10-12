#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupHermesToolchainEnvironment } from './toolchain-environment.mjs';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = path.resolve(packageRoot, '../..');
const toolchainEnvironment = await setupHermesToolchainEnvironment({
    workspaceRoot,
    includeWitBindgen: false
});
Object.assign(process.env, toolchainEnvironment);
const cacheRoot = path.resolve(process.env.STATIC_HERMES_CACHE_DIR);
const defaultSource = path.join(cacheRoot, 'source');
const source = configuredPath('STATIC_HERMES_SOURCE_DIR', defaultSource);
const isManagedSource = source === path.resolve(defaultSource);
const hostBuild = configuredPath('STATIC_HERMES_HOST_BUILD_DIR', path.join(cacheRoot, 'build-host'));
const wasiBuild = configuredPath('STATIC_HERMES_WASI_BUILD_DIR', path.join(cacheRoot, 'build-wasip2'));
const enableJsiExtensions = process.env.STATIC_HERMES_ENABLE_JSI_EXTENSIONS === '1';
const enableUnicodeRegexpPropertyEscapes = process.env.STATIC_HERMES_ENABLE_UNICODE_REGEXP_PROPERTY_ESCAPES !== '0';
const wasiSdk = path.resolve(process.env.STATIC_HERMES_WASI_SDK_PATH);
const buildStatePath = path.join(cacheRoot, 'prepared-build.json');
const buildLockPath = path.join(cacheRoot, 'prepare.lock');
const requiredArtifacts = [
    path.join(hostBuild, 'ImportHostCompilers.cmake'),
    path.join(hostBuild, 'bin/shermes'),
    path.join(hostBuild, 'bin/hermesc'),
    path.join(wasiBuild, 'lib/libhermesvm_a.a'),
    path.join(wasiBuild, 'lib/libhermesvmlean_a.a'),
    path.join(wasiBuild, 'jsi/libjsi.a')
];
const pin = JSON.parse(fs.readFileSync(path.join(packageRoot, 'hermes-source.json'), 'utf8'));
const patchesDir = path.join(packageRoot, 'hermes-patches');
const toolchain = path.join(packageRoot, 'cmake/wasi-sdk-hermes-p2.cmake');
const patches = fs
    .readdirSync(patchesDir)
    .filter((file) => /^\d{4}-.*\.patch$/.test(file))
    .sort()
    .map((file) => path.join(patchesDir, file));
if (patches.length === 0) throw new Error(`No Hermes patches found in ${patchesDir}`);

function run(command, args, options = {}) {
    execFileSync(command, args, { stdio: 'inherit', ...options });
}

function output(command, args, options = {}) {
    return execFileSync(command, args, { encoding: 'utf8', ...options }).replace(/\r?\n$/, '');
}

function configuredPath(name, fallback) {
    return path.resolve(process.env[name] ?? fallback);
}

function hasGitDirectory(directory) {
    try {
        output('git', ['-C', directory, 'rev-parse', '--git-dir']);
        return true;
    } catch {
        return false;
    }
}

function ensureSource() {
    if (!fs.existsSync(source)) {
        clonePinnedSource(source);
    }
    if (!hasGitDirectory(source)) throw new Error(`Hermes source path is not a Git checkout: ${source}`);

    const actualCommit = output('git', ['-C', source, 'rev-parse', 'HEAD']);
    if (actualCommit !== pin.commit) {
        const changes = verifyManagedSourceChanges();
        if (!isManagedSource) {
            throw new Error(`Hermes source is ${actualCommit}, expected pinned commit ${pin.commit}: ${source}`);
        }
        if (changes) verifyChangesAreManaged(changes);
        rebuildStaleSource();
        return;
    }

    const changes = verifyManagedSourceChanges();
    if (changes) verifyChangesAreManaged(changes);

    const patchStates = patches.map((patch) => ({
        patch,
        applied: checkPatch(source, patch, true),
        applicable: checkPatch(source, patch, false)
    }));
    if (patchStates.every(({ applied }) => applied)) return;

    if (changes && patchStates.some(({ applied, applicable }) => !applied && !applicable)) {
        rebuildStaleSource();
        return;
    }

    for (const { patch, applied, applicable } of patchStates) {
        if (applied) continue;
        if (!applicable) throw new Error(`Hermes patch does not apply to pinned commit ${pin.commit}: ${patch}`);
        run('git', ['-C', source, 'apply', patch]);
    }
}

function verifyManagedSourceChanges() {
    return output('git', ['-C', source, 'status', '--porcelain', '--untracked-files=all']);
}

function verifyChangesAreManaged(changes) {
    const changedPaths = new Set(changes.split('\n').map((line) => line.slice(3).replace(/ -> .*/, '')));
    const patchedPaths = new Set(
        patches.flatMap((patch) => {
            const contents = fs.readFileSync(patch, 'utf8');
            return [...contents.matchAll(/^(?:\+\+\+|---) [ab]\/([^\n]+)$/gm)]
                .map((match) => match[1])
                .filter((file) => file !== '/dev/null');
        })
    );
    if ([...changedPaths].some((changedPath) => !patchedPaths.has(changedPath))) {
        throw new Error(`Hermes source has local changes outside the managed patch set: ${source}`);
    }
}

function clonePinnedSource(destination) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    run('git', ['clone', '--filter=blob:none', '--no-checkout', pin.repository, destination]);
    run('git', ['-C', destination, 'fetch', '--depth', '1', 'origin', pin.commit]);
    run('git', ['-C', destination, 'checkout', '--detach', pin.commit]);
}

function rebuildStaleSource() {
    const rebuilding = `${source}.rebuild-${process.pid}-${Date.now()}`;
    const previous = `${source}.stale-${process.pid}-${Date.now()}`;
    try {
        clonePinnedSource(rebuilding);

        for (const patch of patches) {
            if (!checkPatch(rebuilding, patch, false)) {
                throw new Error(`Hermes patch does not apply to pinned commit ${pin.commit}: ${patch}`);
            }
            run('git', ['-C', rebuilding, 'apply', patch]);
        }
    } catch (error) {
        fs.rmSync(rebuilding, { recursive: true, force: true });
        throw error;
    }

    fs.renameSync(source, previous);
    try {
        fs.renameSync(rebuilding, source);
    } catch (error) {
        fs.renameSync(previous, source);
        fs.rmSync(rebuilding, { recursive: true, force: true });
        throw error;
    }

    try {
        fs.rmSync(previous, { recursive: true, force: true });
    } catch (error) {
        console.warn(`Could not remove stale Hermes source cache at ${previous}: ${error.message}`);
    }
    console.log('Rebuilt stale Hermes source cache from the pinned commit and current patch set.');
}

function checkPatch(repository, patch, reverse) {
    try {
        run('git', ['-C', repository, 'apply', '--check', ...(reverse ? ['--reverse'] : []), patch], {
            stdio: 'ignore'
        });
        return true;
    } catch {
        return false;
    }
}

function configureAndBuild() {
    // wasi-sdk 34 stores WASI libc++ headers under target-specific paths. Its
    // Clang driver enables those paths only when this otherwise-empty marker exists.
    fs.mkdirSync(path.join(wasiSdk, 'share/wasi-sysroot/include/c++/v1'), { recursive: true });
    fs.mkdirSync(hostBuild, { recursive: true });
    fs.mkdirSync(wasiBuild, { recursive: true });
    if (!fs.existsSync(toolchain)) throw new Error(`WASI 2 Hermes toolchain file not found: ${toolchain}`);

    // Host-only compiler tools use -Os and omit assertions; these flags do not affect plugin size.
    run('cmake', [
        '-S',
        source,
        '-B',
        hostBuild,
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
    run('cmake', ['--build', hostBuild, '--target', 'shermes', 'hermesc', '--parallel']);

    // Build the WASI runtime for minimum size. -Oz and section splitting let the final link discard
    // unused code; SJLJ is required by Hermes's exception machinery on this target.
    run('cmake', [
        '-S',
        source,
        '-B',
        wasiBuild,
        '-G',
        'Ninja',
        '-DCMAKE_BUILD_TYPE=MinSizeRel',
        `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`,
        `-DWASI_SDK_PREFIX=${wasiSdk}`,
        `-DIMPORT_HOST_COMPILERS=${path.join(hostBuild, 'ImportHostCompilers.cmake')}`,
        '-DCMAKE_C_FLAGS_MINSIZEREL=-Oz -DNDEBUG -ffunction-sections -fdata-sections',
        '-DCMAKE_CXX_FLAGS_MINSIZEREL=-Oz -DNDEBUG -ffunction-sections -fdata-sections -Wno-unused-template',
        // These LLVM options are required for Hermes's setjmp/longjmp exception lowering on WASI.
        '-DCMAKE_C_FLAGS=-mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false',
        // wasi-libc implements these POSIX interfaces through explicit emulation libraries.
        '-DCMAKE_CXX_FLAGS=-mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS',
        // Build-time features not needed in plugin components.
        '-DHERMES_ENABLE_TOOLS=OFF',
        '-DHERMES_ENABLE_TEST_SUITE=OFF',
        '-DHERMES_ENABLE_NAPI=OFF',
        '-DHERMES_ENABLE_DEBUGGER=OFF',
        '-DHERMES_ENABLE_INTL=OFF',
        `-DHERMES_ENABLE_CORE_EXTENSIONS=${enableJsiExtensions ? 'ON' : 'OFF'}`,
        `-DHERMES_ENABLE_CONTRIB_EXTENSIONS=${enableJsiExtensions ? 'ON' : 'OFF'}`,
        `-DHERMES_ENABLE_UNICODE_REGEXP_PROPERTY_ESCAPES=${enableUnicodeRegexpPropertyEscapes ? 'ON' : 'OFF'}`,
        '-DHERMES_BUILD_SHARED_JSI=OFF',
        // Hermes catches JavaScript recursion before the component stack traps.
        '-DHERMES_CHECK_NATIVE_STACK=ON',
        // WASI cannot JIT, and a smaller Unicode implementation is sufficient for this target.
        '-DHERMESVM_ALLOW_JIT=0',
        '-DHERMES_UNICODE_LITE=ON',
        // Hermes's Boost.Context GC is unavailable on this WASI target; MALLOC has higher memory use.
        '-DHERMES_ALLOW_BOOST_CONTEXT=0',
        '-DHERMESVM_GCKIND=MALLOC'
    ]);
    run('cmake', ['--build', wasiBuild, '--target', 'hermesvm_a', 'hermesvmlean_a', 'jsi', '--parallel']);
}

function fileDigest(filename) {
    return createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function compilerIdentity(buildDirectory, cacheKey, fallback) {
    const cache = path.join(buildDirectory, 'CMakeCache.txt');
    const cacheText = fs.existsSync(cache) ? fs.readFileSync(cache, 'utf8') : '';
    const cachedCompiler = cacheText.match(new RegExp(`^${cacheKey}:[^=]+=([^\\n]+)$`, 'm'))?.[1];
    const command = cachedCompiler ?? fallback;
    return { command, version: output(command, ['--version']) };
}

function artifactState(filename) {
    if (!fs.existsSync(filename)) return null;
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size === 0) return null;
    return { size: stat.size, mtimeMs: stat.mtimeMs };
}

function buildFingerprint() {
    const status = output('git', ['-C', source, 'status', '--porcelain', '--untracked-files=all']);
    const untrackedFiles = output('git', ['-C', source, 'ls-files', '--others', '--exclude-standard', '-z'])
        .split('\0')
        .filter(Boolean)
        .map((filename) => [filename, fileDigest(path.join(source, filename))]);
    const inputs = {
        schema: 1,
        source: {
            commit: output('git', ['-C', source, 'rev-parse', 'HEAD']),
            diff: createHash('sha256')
                .update(execFileSync('git', ['-C', source, 'diff', '--binary', 'HEAD']))
                .digest('hex'),
            status,
            untrackedFiles
        },
        pin: fileDigest(path.join(packageRoot, 'hermes-source.json')),
        patches: patches.map((patch) => [path.basename(patch), fileDigest(patch)]),
        prepareScript: fileDigest(fileURLToPath(import.meta.url)),
        toolchainSetup: fileDigest(path.join(packageRoot, 'bin/toolchain-environment.mjs')),
        toolchainFile: fileDigest(toolchain),
        toolchain: {
            wasiSdk,
            wasiC: output(path.join(wasiSdk, 'bin/wasm32-wasip2-clang'), ['--version']),
            wasiCxx: output(path.join(wasiSdk, 'bin/wasm32-wasip2-clang++'), ['--version']),
            hostC: compilerIdentity(hostBuild, 'CMAKE_C_COMPILER', process.env.CC ?? 'cc'),
            hostCxx: compilerIdentity(hostBuild, 'CMAKE_CXX_COMPILER', process.env.CXX ?? 'c++'),
            wasiHostC: compilerIdentity(wasiBuild, 'CMAKE_C_COMPILER', path.join(wasiSdk, 'bin/wasm32-wasip2-clang')),
            wasiHostCxx: compilerIdentity(
                wasiBuild,
                'CMAKE_CXX_COMPILER',
                path.join(wasiSdk, 'bin/wasm32-wasip2-clang++')
            ),
            cmake: output('cmake', ['--version']),
            ninja: output('ninja', ['--version'])
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
                .filter((name) => process.env[name] !== undefined)
                .map((name) => [name, process.env[name]])
        ),
        options: {
            platform: process.platform,
            arch: process.arch,
            source,
            hostBuild,
            wasiBuild,
            enableJsiExtensions,
            enableUnicodeRegexpPropertyEscapes
        },
        cmakeCaches: [hostBuild, wasiBuild].map((buildDirectory) => {
            const filename = path.join(buildDirectory, 'CMakeCache.txt');
            return fs.existsSync(filename) ? fileDigest(filename) : null;
        }),
        artifacts: requiredArtifacts.map((filename) => [filename, artifactState(filename)])
    };
    return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

function isBuildCacheCurrent(fingerprint) {
    if (requiredArtifacts.some((filename) => artifactState(filename) === null) || !fs.existsSync(buildStatePath)) {
        return false;
    }
    try {
        return JSON.parse(fs.readFileSync(buildStatePath, 'utf8')).fingerprint === fingerprint;
    } catch {
        return false;
    }
}

function saveBuildCache(fingerprint) {
    fs.mkdirSync(cacheRoot, { recursive: true });
    const temporary = `${buildStatePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ fingerprint }, null, 2)}\n`);
    fs.renameSync(temporary, buildStatePath);
}

function processIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

function staleBuildLock() {
    let stat;
    try {
        stat = fs.statSync(buildLockPath);
    } catch (error) {
        if (error.code === 'ENOENT') return true;
        throw error;
    }
    try {
        const owner = JSON.parse(fs.readFileSync(buildLockPath, 'utf8'));
        if (Number.isInteger(owner.pid) && owner.pid > 0) return !processIsAlive(owner.pid);
    } catch (error) {
        if (!(error instanceof SyntaxError)) {
            if (error.code === 'ENOENT') return true;
            throw error;
        }
    }
    return Date.now() - stat.mtimeMs > 60_000;
}

async function acquireBuildLock() {
    fs.mkdirSync(cacheRoot, { recursive: true });
    const deadline = Date.now() + 30 * 60_000;
    while (true) {
        try {
            fs.writeFileSync(buildLockPath, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`, {
                flag: 'wx'
            });
            return;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            if (staleBuildLock()) {
                fs.rmSync(buildLockPath, { force: true });
                continue;
            }
            if (Date.now() >= deadline) throw new Error(`Timed out waiting for Hermes build lock: ${buildLockPath}`);
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
}

await acquireBuildLock();
try {
    ensureSource();
    const fingerprint = buildFingerprint();
    if (isBuildCacheCurrent(fingerprint)) {
        console.log('Hermes build cache is current; skipping rebuild.');
    } else {
        configureAndBuild();
        saveBuildCache(buildFingerprint());
    }
} finally {
    fs.rmSync(buildLockPath, { force: true });
}

console.log(`Static Hermes is ready. Source: ${source}; WASI 2 libraries: ${wasiBuild}`);
