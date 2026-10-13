import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const runtimeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(runtimeDir, '../..');
const runtimeCli = path.join(runtimeDir, 'dist/cli.js');

it('routes the prepare-hermes package script through the compiled CLI', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'package.json'), 'utf8'));
    expect(manifest.scripts['prepare-hermes']).toBe('pnpm build && node dist/cli.js hermes prepare');
    expect(fs.existsSync(runtimeCli)).toBe(true);
});

it('extends Hermes OS compatibility sources without replacing existing platforms', () => {
    const patch = fs.readFileSync(
        path.join(runtimeDir, 'hermes-patches/0001-wasi-p2-configure-platform.patch'),
        'utf8'
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

it('returns an explicit unsupported error when WASI footprint is unavailable', () => {
    const patch = fs.readFileSync(
        path.join(runtimeDir, 'hermes-patches/0004-wasi-p2-runtime-compatibility.patch'),
        'utf8'
    );
    const vmFootprint = patch.match(
        /^\+llvh::ErrorOr<size_t> vm_footprint\(char \*start, char \*end\) \{\n(?:^\+.*\n)*?^\+\}/m
    )?.[0];

    expect(vmFootprint).toContain('std::errc::operation_not_supported');
    expect(vmFootprint).not.toContain('errno');
});

it('rounds WASI aligned allocation sizes up to the requested alignment', () => {
    const patch = fs.readFileSync(
        path.join(runtimeDir, 'hermes-patches/0004-wasi-p2-runtime-compatibility.patch'),
        'utf8'
    );
    const allocation = patch.match(
        /^\+vm_allocate_aligned\(size_t sz, size_t alignment, void \* \/\* hint \*\/\) \{\n(?:^\+.*\n)*?^\+\}/m
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
        /^diff --git a\/external\/llvh\/lib\/Support\/Wasi\/(?:Host\.inc|Path\.inc|Process\.inc|Unix\.h) /m
    );
});

it('builds patched Hermes once, reuses the cache, and invalidates it when settings change', async () => {
    const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-prepare-'));
    try {
        const fakeBin = path.join(temporaryDir, 'bin');
        const source = path.join(temporaryDir, 'source');
        const wasiSdk = path.join(temporaryDir, 'wasi-sdk');
        fs.mkdirSync(fakeBin, { recursive: true });
        fs.mkdirSync(source, { recursive: true });
        fs.mkdirSync(path.join(wasiSdk, 'bin'), { recursive: true });
        writeExecutable(path.join(wasiSdk, 'bin', 'wasm32-wasip2-clang'), "printf 'WASI SDK fake 34\\n'\n");
        writeExecutable(path.join(wasiSdk, 'bin', 'wasm32-wasip2-clang++'), "printf 'WASI SDK fake 34\\n'\n");

        const fakeGit = path.join(fakeBin, 'git');
        fs.writeFileSync(
            fakeGit,
            `#!/bin/sh
case " $* " in
  *" rev-parse --git-dir "*) printf '.git\\n' ;;
  *" rev-parse HEAD "*) printf '820aa0d4b5fe5d3ed7900e1274211ef561081b3f\\n' ;;
  *" status --porcelain "*) printf ' M cmake/modules/Hermes.cmake\\n' ;;
  *" apply --check --reverse "*0004-wasi-p2-runtime-compatibility.patch*)
    if [ -f "$STATIC_HERMES_TEST_PATCHED_0004" ]; then exit 0; else exit 1; fi
    ;;
  *" apply --check --reverse "*) exit 0 ;;
  *" apply --check "*) exit 0 ;;
  *" apply "*0004-wasi-p2-runtime-compatibility.patch*) touch "$STATIC_HERMES_TEST_PATCHED_0004"; exit 0 ;;
  *" apply "*) exit 0 ;;
  *) exit 0 ;;
esac
`
        );
        fs.chmodSync(fakeGit, 0o755);
        const fakeCmake = path.join(fakeBin, 'cmake');
        const cmakeLog = path.join(temporaryDir, 'cmake.log');
        fs.writeFileSync(
            fakeCmake,
            `#!/bin/sh
printf "%s\\n" "$*" >> "$STATIC_HERMES_FAKE_CMAKE_LOG"
if [ "$1" = "--version" ]; then printf 'cmake version 3.test\\n'; exit 0; fi
if [ "$1" = "--build" ]; then
  if [ "$4" = "shermes" ]; then
    mkdir -p "$2/bin"
    printf 'fake compiler' > "$2/bin/shermes"
    printf 'fake compiler' > "$2/bin/hermesc"
    printf 'fake host imports' > "$2/ImportHostCompilers.cmake"
  else
    mkdir -p "$2/lib" "$2/jsi"
    printf 'fake archive' > "$2/lib/libhermesvm_a.a"
    printf 'fake archive' > "$2/lib/libhermesvmlean_a.a"
    printf 'fake archive' > "$2/jsi/libjsi.a"
  fi
fi
exit 0
`
        );
        fs.chmodSync(fakeCmake, 0o755);

        const environment = {
            ...process.env,
            PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
            STATIC_HERMES_CACHE_DIR: path.join(temporaryDir, 'cache'),
            STATIC_HERMES_SOURCE_DIR: source,
            STATIC_HERMES_HOST_BUILD_DIR: path.join(temporaryDir, 'build-host'),
            STATIC_HERMES_WASI_BUILD_DIR: path.join(temporaryDir, 'build-wasip2'),
            STATIC_HERMES_WASI_SDK_PATH: wasiSdk,
            STATIC_HERMES_TEST_PATCHED_0004: path.join(temporaryDir, 'patch-0004-applied'),
            STATIC_HERMES_FAKE_CMAKE_LOG: cmakeLog
        };
        const [result, concurrent] = await Promise.all([runPrepare(environment), runPrepare(environment)]);

        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(concurrent.status, concurrent.stderr).toBe(0);
        expect(result.stdout).toContain('Static Hermes is ready.');
        expect(concurrent.stdout).toContain('Static Hermes is ready.');
        expect(fs.readFileSync(cmakeLog, 'utf8')).toContain('--build');
        expect(fs.readFileSync(cmakeLog, 'utf8')).toContain('--target shermes hermesc --parallel');
        expect(fs.readFileSync(cmakeLog, 'utf8')).toContain('--target hermesvm_a hermesvmlean_a jsi --parallel');
        expect(fs.readFileSync(cmakeLog, 'utf8')).toContain(
            '-DCMAKE_CXX_FLAGS_RELEASE=-Os -DNDEBUG -Wno-unused-template'
        );
        expect(fs.readFileSync(cmakeLog, 'utf8')).toContain(
            '-DCMAKE_CXX_FLAGS_MINSIZEREL=-Oz -DNDEBUG -ffunction-sections -fdata-sections -Wno-unused-template'
        );

        const firstBuildCount = fs
            .readFileSync(cmakeLog, 'utf8')
            .split('\n')
            .filter((line) => line.startsWith('--build ')).length;
        expect(firstBuildCount).toBe(2);

        const cached = await runPrepare(environment);
        expect(cached.status, cached.stderr).toBe(0);
        expect(cached.stdout).toContain('Hermes build cache is current; skipping rebuild.');
        expect(
            fs
                .readFileSync(cmakeLog, 'utf8')
                .split('\n')
                .filter((line) => line.startsWith('--build '))
        ).toHaveLength(firstBuildCount);

        const changedSettings = await runPrepare({ ...environment, STATIC_HERMES_ENABLE_JSI_EXTENSIONS: '1' });
        expect(changedSettings.status, changedSettings.stderr).toBe(0);
        expect(changedSettings.stdout).not.toContain('Hermes build cache is current; skipping rebuild.');
        expect(fs.readFileSync(cmakeLog, 'utf8')).toContain('-DHERMES_ENABLE_CORE_EXTENSIONS=ON');
        expect(
            fs
                .readFileSync(cmakeLog, 'utf8')
                .split('\n')
                .filter((line) => line.startsWith('--build '))
        ).toHaveLength(firstBuildCount * 2);
    } finally {
        fs.rmSync(temporaryDir, { recursive: true, force: true });
    }
}, 20_000);

it('rebuilds a stale source cache when a managed Hermes patch no longer applies', () => {
    const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-stale-cache-'));
    try {
        const fakeBin = path.join(temporaryDir, 'bin');
        const source = path.join(temporaryDir, 'source');
        const wasiSdk = path.join(temporaryDir, 'wasi-sdk');
        fs.mkdirSync(fakeBin, { recursive: true });
        fs.mkdirSync(source, { recursive: true });
        fs.mkdirSync(path.join(wasiSdk, 'bin'), { recursive: true });
        writeExecutable(path.join(wasiSdk, 'bin', 'wasm32-wasip2-clang'), "printf 'WASI SDK fake 34\\n'\n");
        writeExecutable(path.join(wasiSdk, 'bin', 'wasm32-wasip2-clang++'), "printf 'WASI SDK fake 34\\n'\n");

        const fakeGit = path.join(fakeBin, 'git');
        fs.writeFileSync(
            fakeGit,
            `#!/bin/sh
args=" $* "
repo=
if [ "$1" = "-C" ]; then repo="$2"; fi
case "$args" in
  *" clone "*)
    target=
    for arg do target=$arg; done
    mkdir -p "$target/.git"
    case "$target" in *source.rebuild-*) touch "$STATIC_HERMES_TEST_FRESH_SOURCE" ;; esac
    ;;
  *" rev-parse --git-dir "*) printf '.git\\n' ;;
  *" rev-parse HEAD "*) printf '820aa0d4b5fe5d3ed7900e1274211ef561081b3f\\n' ;;
  *" status --porcelain "*)
    case "$repo" in *source.rebuild-*) exit 0 ;; esac
    printf ' M cmake/modules/Hermes.cmake\\n'
    ;;
  *" apply --check --reverse "*0004-wasi-p2-runtime-compatibility.patch*)
    if [ -f "$STATIC_HERMES_TEST_PATCHED_0004" ]; then exit 0; fi
    case "$repo" in *source.rebuild-*) exit 1 ;; esac
    exit 1
    ;;
  *" apply --check --reverse "*)
    case "$repo" in *source.rebuild-*) exit 1 ;; esac
    exit 0
    ;;
  *" apply --check "*0004-wasi-p2-runtime-compatibility.patch*)
    if [ -f "$STATIC_HERMES_TEST_PATCHED_0004" ]; then exit 1; fi
    if [ -f "$STATIC_HERMES_TEST_FRESH_SOURCE" ]; then exit 0; fi
    exit 1
    ;;
  *" apply "*0004-wasi-p2-runtime-compatibility.patch*) touch "$STATIC_HERMES_TEST_PATCHED_0004"; exit 0 ;;
  *" apply --check "*) exit 0 ;;
  *) exit 0 ;;
esac
`
        );
        fs.chmodSync(fakeGit, 0o755);
        const fakeCmake = path.join(fakeBin, 'cmake');
        const cmakeLog = path.join(temporaryDir, 'cmake.log');
        fs.writeFileSync(fakeCmake, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$STATIC_HERMES_FAKE_CMAKE_LOG"\nexit 0\n');
        fs.chmodSync(fakeCmake, 0o755);

        const result = spawnSync(process.execPath, [runtimeCli, 'hermes', 'prepare'], {
            cwd: workspaceRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
                STATIC_HERMES_CACHE_DIR: path.join(temporaryDir, 'cache'),
                STATIC_HERMES_SOURCE_DIR: source,
                STATIC_HERMES_HOST_BUILD_DIR: path.join(temporaryDir, 'build-host'),
                STATIC_HERMES_WASI_BUILD_DIR: path.join(temporaryDir, 'build-wasip2'),
                STATIC_HERMES_WASI_SDK_PATH: wasiSdk,
                STATIC_HERMES_TEST_PATCHED_0004: path.join(temporaryDir, 'patch-0004-applied'),
                STATIC_HERMES_TEST_FRESH_SOURCE: path.join(temporaryDir, 'fresh-source'),
                STATIC_HERMES_FAKE_CMAKE_LOG: cmakeLog
            }
        });

        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toContain('Rebuilt stale Hermes source cache');
        expect(fs.existsSync(source)).toBe(true);
        expect(fs.readdirSync(temporaryDir).some((name) => name.startsWith('source.rebuild-'))).toBe(false);
        expect(fs.readFileSync(cmakeLog, 'utf8')).toContain('--build');
    } finally {
        fs.rmSync(temporaryDir, { recursive: true, force: true });
    }
}, 30_000);

it('refreshes the managed Hermes checkout when its pinned commit changes', () => {
    const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-pin-refresh-'));
    try {
        const fakeBin = path.join(temporaryDir, 'bin');
        const cache = path.join(temporaryDir, 'cache');
        const source = path.join(cache, 'source');
        const wasiSdk = path.join(temporaryDir, 'wasi-sdk');
        fs.mkdirSync(fakeBin, { recursive: true });
        fs.mkdirSync(source, { recursive: true });
        writeExecutable(path.join(wasiSdk, 'bin/wasm32-wasip2-clang'), "printf 'WASI SDK fake 34\\n'\n");
        writeExecutable(path.join(wasiSdk, 'bin/wasm32-wasip2-clang++'), "printf 'WASI SDK fake 34\\n'\n");

        const fakeGit = path.join(fakeBin, 'git');
        fs.writeFileSync(
            fakeGit,
            `#!/bin/sh
args=" $* "
repo=
if [ "$1" = "-C" ]; then repo="$2"; fi
case "$args" in
  *" clone "*)
    target=
    for arg do target=$arg; done
    mkdir -p "$target/.git"
    touch "$target/.hermes-pinned"
    ;;
  *" rev-parse --git-dir "*) printf '.git\\n' ;;
  *" rev-parse HEAD "*)
    if [ -f "$repo/.hermes-pinned" ]; then
      printf '820aa0d4b5fe5d3ed7900e1274211ef561081b3f\\n'
    else
      printf '1111111111111111111111111111111111111111\\n'
    fi
    ;;
  *" apply --check "*) exit 0 ;;
  *) exit 0 ;;
esac
`
        );
        fs.chmodSync(fakeGit, 0o755);
        const fakeCmake = path.join(fakeBin, 'cmake');
        fs.writeFileSync(
            fakeCmake,
            `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'cmake version 3.test\\n'; fi
exit 0
`
        );
        fs.chmodSync(fakeCmake, 0o755);

        const result = spawnSync(process.execPath, [runtimeCli, 'hermes', 'prepare'], {
            cwd: workspaceRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
                STATIC_HERMES_CACHE_DIR: cache,
                STATIC_HERMES_WASI_SDK_PATH: wasiSdk
            }
        });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('Rebuilt stale Hermes source cache from the pinned commit.');
        expect(fs.existsSync(path.join(source, '.hermes-pinned'))).toBe(true);
        expect(fs.readdirSync(cache).some((name) => name.startsWith('source.rebuild-'))).toBe(false);
    } finally {
        fs.rmSync(temporaryDir, { recursive: true, force: true });
    }
}, 30_000);

function writeExecutable(file, body = 'exit 0\n') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\n${body}`);
    fs.chmodSync(file, 0o755);
}

function runPrepare(env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [runtimeCli, 'hermes', 'prepare'], { cwd: workspaceRoot, env });
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
