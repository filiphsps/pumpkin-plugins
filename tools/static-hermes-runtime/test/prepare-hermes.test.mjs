import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const runtimeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeCli = path.join(runtimeDir, 'dist/cli.js');

it('routes the prepare-hermes package script through the compiled CLI', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'package.json'), 'utf8'));
    expect(manifest.scripts['prepare-hermes']).toBe('pnpm build && node dist/cli.js hermes prepare');
    expect(fs.existsSync(runtimeCli)).toBe(true);
});

it('normalizes Windows SDK paths before CMake propagates them to try_compile', () => {
    const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-toolchain-path-'));
    try {
        const probe = path.join(temporaryDir, 'toolchain-path-probe.cmake');
        const toolchainFile = path.join(runtimeDir, 'cmake/wasi-sdk-hermes-p2.cmake').replaceAll('\\', '/');
        fs.writeFileSync(probe, `include("${toolchainFile}")\nmessage(STATUS "WASI_SDK_PREFIX=\${WASI_SDK_PREFIX}")\n`);

        const result = spawnSync('cmake', ['-DWASI_SDK_PREFIX=C:\\Users\\runner\\wasi-sdk', '-P', probe], {
            encoding: 'utf8',
        });
        const output = `${result.stdout}\n${result.stderr}`;

        expect(result.status, output).toBe(0);
        expect(output).toContain('WASI_SDK_PREFIX=C:/Users/runner/wasi-sdk');
    } finally {
        fs.rmSync(temporaryDir, { recursive: true, force: true });
    }
});

it('extends Hermes OS compatibility sources without replacing existing platforms', () => {
    const patch = fs.readFileSync(
        path.join(runtimeDir, 'hermes-patches/0001-wasi-p2-configure-platform.patch'),
        'utf8',
    );
    const supportSources = patch
        .slice(patch.indexOf('diff --git a/lib/Support/CMakeLists.txt '))
        .split('\ndiff --git ')[0];

    expect(supportSources).toContain(' OSCompatEmscripten.cpp');
    expect(supportSources).toContain(' OSCompatPosix.cpp');
    expect(supportSources).toContain('+        OSCompatWASI.cpp');
    expect(supportSources).not.toMatch(/^-[ \t]+OSCompat(?:Emscripten|Posix|Windows)\.cpp$/m);
});

it('keeps LLVH Unix and Windows implementations independent when adding WASI', () => {
    const patch = fs.readFileSync(path.join(runtimeDir, 'hermes-patches/0002-wasi-p2-llvh-portability.patch'), 'utf8');

    expect(patch).toContain('+#if defined(__wasi__)');
    expect(patch).not.toMatch(/^-[ \t]*#ifdef _WIN32$/m);
    expect(patch).not.toMatch(/^\+#elif defined\((?:LLVM_ON_UNIX|_WIN32)\)$/m);
});

it('does not apply Windows host defines to WASI Hermes builds', () => {
    const patch = fs.readFileSync(
        path.join(runtimeDir, 'hermes-patches/0001-wasi-p2-configure-platform.patch'),
        'utf8',
    );

    expect(patch).toContain('+if (WIN32 AND NOT HERMES_WASI_TARGET)');
    expect(patch).toContain('+if (WIN32 AND NOT CMAKE_SYSTEM_NAME STREQUAL "WASI")');
    expect(patch).toContain('-else (WIN32)\n-  if (FUCHSIA OR UNIX)\n+else ()');
    expect(patch).toContain('-  endif (FUCHSIA OR UNIX)\n-endif (WIN32)\n+  endif ()\n+endif ()');
});

it('returns an explicit unsupported error when WASI footprint is unavailable', () => {
    const patch = fs.readFileSync(
        path.join(runtimeDir, 'hermes-patches/0004-wasi-p2-runtime-compatibility.patch'),
        'utf8',
    );
    const vmFootprint = patch.match(
        /^\+llvh::ErrorOr<size_t> vm_footprint\(char \*start, char \*end\) \{\n(?:^\+.*\n)*?^\+\}/m,
    )?.[0];

    expect(vmFootprint).toContain('std::errc::operation_not_supported');
    expect(vmFootprint).not.toContain('errno');
});

it('rounds WASI aligned allocation sizes up to the requested alignment', () => {
    const patch = fs.readFileSync(
        path.join(runtimeDir, 'hermes-patches/0004-wasi-p2-runtime-compatibility.patch'),
        'utf8',
    );
    const allocation = patch.match(
        /^\+vm_allocate_aligned\(size_t sz, size_t alignment, void \* \/\* hint \*\/\) \{\n(?:^\+.*\n)*?^\+\}/m,
    )?.[0];

    expect(allocation).toContain('std::numeric_limits<size_t>::max() - (alignment - 1)');
    expect(allocation).toMatch(/const size_t allocationSize =\n\+\s+\(sz \+ alignment - 1\) & ~\(alignment - 1\);/);
    expect(allocation).toContain('aligned_alloc(alignment, allocationSize)');
    expect(allocation).toMatch(/if \(!p\)\n\+\s+return std::make_error_code\(std::errc::not_enough_memory\);/);
    expect(allocation).not.toContain('aligned_alloc(alignment, sz)');
});

it('reuses shared LLVH Unix helpers instead of copying them into the WASI tree', () => {
    const patch = fs
        .readdirSync(path.join(runtimeDir, 'hermes-patches'))
        .filter((name) => name.endsWith('.patch'))
        .map((name) => fs.readFileSync(path.join(runtimeDir, 'hermes-patches', name), 'utf8'))
        .join('\n');

    expect(patch).not.toMatch(
        /^diff --git a\/external\/llvh\/lib\/Support\/Wasi\/(?:Host\.inc|Path\.inc|Process\.inc|Unix\.h) /m,
    );
});

it('builds patched Hermes once, reuses the cache, and invalidates it when settings change', async () => {
    const fixture = prepareFixture();
    try {
        const source = path.join(fixture.root, 'source');
        git(fixture.root, ['clone', '--quiet', fixture.upstream, source]);
        const environment = fixture.environment({ STATIC_HERMES_SOURCE_DIR: source });
        const [result, concurrent] = await Promise.all([
            runPrepare(fixture, environment),
            runPrepare(fixture, environment),
        ]);

        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(concurrent.status, concurrent.stderr).toBe(0);
        expect(result.stdout).toContain('Static Hermes is ready.');
        expect(concurrent.stdout).toContain('Static Hermes is ready.');
        expect(fs.readFileSync(path.join(source, 'lines.txt'), 'utf8')).toBe(patchedLines);
        const cmakeLog = () => fs.readFileSync(fixture.cmakeLog, 'utf8');
        expect(cmakeLog()).toContain('--target shermes hermesc --parallel');
        expect(cmakeLog()).toContain('--target hermesvm_a hermesvmlean_a jsi --parallel');
        expect(cmakeLog()).toContain('-DCMAKE_CXX_FLAGS_RELEASE=-Os -DNDEBUG -Wno-unused-template');
        expect(cmakeLog()).toContain(
            '-DCMAKE_CXX_FLAGS_MINSIZEREL=-Oz -DNDEBUG -ffunction-sections -fdata-sections -Wno-unused-template',
        );

        const buildCount = () =>
            cmakeLog()
                .split('\n')
                .filter((line) => line.startsWith('--build ')).length;
        const firstBuildCount = buildCount();
        expect(firstBuildCount).toBe(2);

        const cached = await runPrepare(fixture, environment);
        expect(cached.status, cached.stderr).toBe(0);
        expect(cached.stdout).toContain('Hermes build cache is current; skipping rebuild.');
        expect(buildCount()).toBe(firstBuildCount);

        const changedSettings = await runPrepare(fixture, { ...environment, STATIC_HERMES_ENABLE_JSI_EXTENSIONS: '1' });
        expect(changedSettings.status, changedSettings.stderr).toBe(0);
        expect(changedSettings.stdout).not.toContain('Hermes build cache is current; skipping rebuild.');
        expect(cmakeLog()).toContain('-DHERMES_ENABLE_CORE_EXTENSIONS=ON');
        expect(buildCount()).toBe(firstBuildCount * 2);
    } finally {
        fixture.remove();
    }
}, 30_000);

it('rebuilds a stale source cache when a managed Hermes patch no longer applies', async () => {
    const fixture = prepareFixture();
    try {
        const source = path.join(fixture.cache, 'source');
        git(fixture.root, ['clone', '--quiet', fixture.upstream, source]);
        fs.writeFileSync(path.join(source, 'lines.txt'), 'a\nb\nold patch\nd\n');

        const result = await runPrepare(fixture, fixture.environment());

        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toContain('Rebuilt stale Hermes source cache');
        expect(fs.readFileSync(path.join(source, 'lines.txt'), 'utf8')).toBe(patchedLines);
        expect(fs.readdirSync(fixture.cache).some((name) => name.startsWith('source.'))).toBe(false);
        expect(fs.readFileSync(fixture.cmakeLog, 'utf8')).toContain('--build');
    } finally {
        fixture.remove();
    }
}, 30_000);

it('refreshes the managed Hermes checkout when its pinned commit changes', async () => {
    const fixture = prepareFixture();
    try {
        const source = path.join(fixture.cache, 'source');
        git(fixture.root, ['clone', '--quiet', fixture.upstream, source]);
        git(source, ['checkout', '--quiet', '--detach', fixture.oldCommit]);

        const result = await runPrepare(fixture, fixture.environment());

        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toContain('Rebuilt stale Hermes source cache from the pinned commit.');
        expect(git(source, ['rev-parse', 'HEAD']).trim()).toBe(fixture.commit);
        expect(fs.readFileSync(path.join(source, 'lines.txt'), 'utf8')).toBe(patchedLines);
        expect(fs.readdirSync(fixture.cache).some((name) => name.startsWith('source.'))).toBe(false);
    } finally {
        fixture.remove();
    }
}, 30_000);

const fixtureRepository = 'https://hermes-fixture.invalid/hermes.git';
const patchedLines = 'a\nB\nc\nd\n';

/**
 * Create a runtime package copy with a fixture pin and patch, a local upstream Git repository that the pin's HTTPS
 * URL is rewritten to, a fake WASI SDK, and a fake CMake that records its arguments.
 */
function prepareFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-prepare-'));
    const packageRoot = path.join(root, 'runtime');
    fs.mkdirSync(packageRoot);
    for (const entry of [
        'dist',
        'cmake',
        'package.json',
        'toolchain-versions.json',
        'wasi-sdk.lock.json',
        'wasm-tools.lock.json',
    ]) {
        fs.cpSync(path.join(runtimeDir, entry), path.join(packageRoot, entry), { recursive: true });
    }
    fs.symlinkSync(path.join(runtimeDir, 'node_modules'), path.join(packageRoot, 'node_modules'), 'junction');

    const working = path.join(root, 'working');
    fs.mkdirSync(working);
    git(working, ['init', '--quiet']);
    fs.writeFileSync(path.join(working, 'lines.txt'), 'a\nb\nc\nd\n');
    git(working, ['add', '.']);
    git(working, ['commit', '--quiet', '-m', 'old pinned source']);
    const oldCommit = git(working, ['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(working, 'other.txt'), 'other\n');
    git(working, ['add', '.']);
    git(working, ['commit', '--quiet', '-m', 'pinned source']);
    const commit = git(working, ['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(working, 'lines.txt'), patchedLines);
    fs.mkdirSync(path.join(packageRoot, 'hermes-patches'));
    fs.writeFileSync(path.join(packageRoot, 'hermes-patches/0001-fixture.patch'), git(working, ['diff']));
    fs.writeFileSync(
        path.join(packageRoot, 'hermes-source.lock.json'),
        JSON.stringify({ repository: fixtureRepository, branch: 'main', commit }),
    );
    const upstream = path.join(root, 'upstream.git');
    git(root, ['clone', '--quiet', '--bare', working, upstream]);
    const gitConfig = path.join(root, 'gitconfig');
    fs.writeFileSync(
        gitConfig,
        `[url "${upstream.replaceAll('\\', '/')}"]\n\tinsteadOf = ${fixtureRepository}\n[user]\n\tname = Hermes test\n\temail = hermes-test@example.com\n[commit]\n\tgpgsign = false\n`,
    );

    const fakeBin = path.join(root, 'bin');
    const wasiSdk = path.join(root, 'wasi-sdk');
    writeExecutable(path.join(wasiSdk, 'bin', 'wasm32-wasip2-clang'), "printf 'WASI SDK fake 34\\n'\n");
    writeExecutable(path.join(wasiSdk, 'bin', 'wasm32-wasip2-clang++'), "printf 'WASI SDK fake 34\\n'\n");
    writeExecutable(
        path.join(fakeBin, 'cmake'),
        `printf "%s\\n" "$*" >> "$STATIC_HERMES_FAKE_CMAKE_LOG"
case " $* " in *" --version "*) printf 'cmake version 3.test\\n'; exit 0 ;; esac
build=
previous=
for arg do
  if [ "$previous" = "--build" ]; then build=$arg; fi
  previous=$arg
done
[ -n "$build" ] || exit 0
case " $* " in *" shermes "*)
  mkdir -p "$build/bin"
  printf 'fake compiler' > "$build/bin/shermes"
  printf 'fake compiler' > "$build/bin/hermesc"
  printf 'fake host imports' > "$build/ImportHostCompilers.cmake"
;; esac
case " $* " in *" hermesvm_a "*)
  mkdir -p "$build/lib" "$build/jsi"
  printf 'fake archive' > "$build/lib/libhermesvm_a.a"
  printf 'fake archive' > "$build/lib/libhermesvmlean_a.a"
  printf 'fake archive' > "$build/jsi/libjsi.a"
;; esac
exit 0
`,
    );

    const cache = path.join(root, 'cache');
    const cmakeLog = path.join(root, 'cmake.log');
    return {
        root,
        packageRoot,
        upstream,
        cache,
        cmakeLog,
        commit,
        oldCommit,
        environment(overrides = {}) {
            return {
                ...process.env,
                GIT_CONFIG_GLOBAL: gitConfig,
                GIT_CONFIG_NOSYSTEM: '1',
                PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
                STATIC_HERMES_CACHE_DIR: cache,
                STATIC_HERMES_HOST_BUILD_DIR: path.join(root, 'build-host'),
                STATIC_HERMES_WASI_BUILD_DIR: path.join(root, 'build-wasip2'),
                STATIC_HERMES_WASI_SDK_PATH: wasiSdk,
                STATIC_HERMES_FAKE_CMAKE_LOG: cmakeLog,
                ...overrides,
            };
        },
        remove() {
            fs.rmSync(root, { recursive: true, force: true });
        },
    };
}

function git(cwd, args) {
    return execFileSync('git', ['-c', 'commit.gpgsign=false', '-C', cwd, ...args], {
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Hermes test',
            GIT_AUTHOR_EMAIL: 'hermes-test@example.com',
            GIT_COMMITTER_NAME: 'Hermes test',
            GIT_COMMITTER_EMAIL: 'hermes-test@example.com',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function writeExecutable(file, body = 'exit 0\n') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\n${body}`);
    fs.chmodSync(file, 0o755);
}

function runPrepare(fixture, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(fixture.packageRoot, 'dist/cli.js'), 'hermes', 'prepare'], {
            cwd: fixture.root,
            env,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.setEncoding('utf8').on('data', (chunk) => {
            stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
}
