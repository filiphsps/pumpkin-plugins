#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareStaticHermesBuild } from './toolchain-environment.mjs';

const runtimeRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error(`Invalid argument near ${key ?? '(end)'}`);
    args.set(key.slice(2), value);
}

const bundle = required('bundle');
const witDir = required('wit');
const output = required('output');
const developmentMode = args.get('development-mode') === 'true';
const runtimeVariant =
    args.get('runtime-variant') ?? (process.env.STATIC_HERMES_ENABLE_LEAN_ARCHIVE === '0' ? 'full' : 'lean');
if (runtimeVariant !== 'full' && runtimeVariant !== 'lean') {
    throw new Error('--runtime-variant must be "full" or "lean"');
}
const stackSizeBytes = process.env.STATIC_HERMES_STACK_SIZE ?? '262144';
if (!/^\d+$/.test(stackSizeBytes) || Number(stackSizeBytes) < 131072 || Number(stackSizeBytes) % 16 !== 0) {
    throw new Error('STATIC_HERMES_STACK_SIZE must be a multiple of 16 and at least 131072 bytes');
}

const workspaceRoot = path.resolve(runtimeRoot, '../..');
await prepareStaticHermesBuild({ workspaceRoot });

const cacheRoot = path.resolve(process.env.STATIC_HERMES_CACHE_DIR);
const hermesSource = configuredPath('STATIC_HERMES_SOURCE_DIR', path.join(cacheRoot, 'source'));
const hermesHostBuild = configuredPath('STATIC_HERMES_HOST_BUILD_DIR', path.join(cacheRoot, 'build-host'));
const hermesWasiBuild = configuredPath('STATIC_HERMES_WASI_BUILD_DIR', path.join(cacheRoot, 'build-wasip2'));
const wasiSdk = path.resolve(process.env.STATIC_HERMES_WASI_SDK_PATH);
const bindgen = path.resolve(process.env.WIT_BINDGEN);
const hermesRuntimeArchive = path.join(
    hermesWasiBuild,
    `lib/libhermesvm${runtimeVariant === 'lean' ? 'lean' : ''}_a.a`
);
const compiler = path.join(wasiSdk, 'bin', 'wasm32-wasip2-clang');
const cxx = `${compiler}++`;
const hermesc = path.join(hermesHostBuild, 'bin', 'shermes');
const tempDir = fs.mkdtempSync(path.join(path.dirname(output), '.static-hermes-'));

function required(name) {
    const value = args.get(name);
    if (!value) throw new Error(`Missing --${name}`);
    return path.resolve(value);
}

function configuredPath(name, fallback) {
    return path.resolve(process.env[name] ?? fallback);
}

function requirePath(description, location) {
    if (!fs.existsSync(location)) {
        throw new Error(
            `${description} not found at ${location}; run prepare-hermes first (see tools/static-hermes-runtime/README.md)`
        );
    }
}

function run(command, commandArgs) {
    execFileSync(command, commandArgs, { stdio: 'inherit' });
}

try {
    requirePath('Hermes source', hermesSource);
    requirePath('Hermes host compiler', hermesc);
    requirePath(`WASI Hermes ${runtimeVariant} runtime archive`, hermesRuntimeArchive);
    requirePath('WASI Hermes JSI archive', path.join(hermesWasiBuild, 'jsi/libjsi.a'));
    requirePath('wit-bindgen', bindgen);

    const generated = path.join(tempDir, 'wit');
    const unitC = path.join(tempDir, 'plugin_bundle.c');
    const unitObject = path.join(tempDir, 'plugin_bundle.o');
    const bindingsObject = path.join(tempDir, 'plugin.o');
    const shimObject = path.join(tempDir, 'runtime.o');
    const componentType = path.join(generated, 'plugin_component_type.o');
    const hermesIncludes = [
        path.join(hermesSource, 'include'),
        path.join(hermesSource, 'public'),
        path.join(hermesSource, 'API'),
        path.join(hermesSource, 'API/jsi'),
        path.join(hermesSource, 'API/jsi/jsi'),
        path.join(hermesSource, 'external/llvh/include'),
        path.join(hermesWasiBuild, 'include'),
        path.join(hermesWasiBuild, 'lib/config')
    ];
    const generatedApiDir = path.join(runtimeRoot, 'generated');

    fs.mkdirSync(generated, { recursive: true });
    run(bindgen, ['c', witDir, '--world', 'plugin', '--out-dir', generated]);
    run(process.execPath, [
        path.join(runtimeRoot, 'bin/generate-api-enums.mjs'),
        '--wit',
        witDir,
        '--header',
        path.join(generated, 'plugin.h'),
        '--output',
        path.join(generatedApiDir, 'api-enums.generated.h')
    ]);
    // shermes emits C for the bundled JS. Production uses -Os and compact output, then drops
    // function names and debug data. Development uses -Og/-g2 to keep generated code inspectable.
    const hermesOptimization = developmentMode ? ['-Og', '-g2'] : ['-Os', '-Xsmall-c', '-fstrip-function-names', '-g0'];
    // Native production code uses -Oz, disables assertions, and splits sections for linker GC.
    // Development uses -O0/-g but keeps NDEBUG so generated bindings behave like production.
    const nativeOptimization = developmentMode
        ? ['-O0', '-g', '-DNDEBUG']
        : ['-Oz', '-DNDEBUG', '-ffunction-sections', '-fdata-sections'];
    // Always request compiler colors so captured build logs retain readable diagnostics.
    run(hermesc, ['-color', ...hermesOptimization, '-emit-c', '-exported-unit=plugin_bundle', `-o=${unitC}`, bundle]);

    const includeFlags = hermesIncludes.map((include) => `-I${include}`);
    run(compiler, [
        '-c',
        ...nativeOptimization,
        // Select the C implementation of the shim and Hermes's setjmp/longjmp lowering.
        '-DSTATIC_HERMES',
        '-mllvm',
        '-wasm-enable-sjlj',
        '-mllvm',
        // Retain: omitting this option produced an invalid component for Wasmtime.
        '-wasm-use-legacy-eh=false',
        ...includeFlags,
        `-I${generated}`,
        '-o',
        unitObject,
        unitC
    ]);
    run(compiler, [
        '-c',
        ...nativeOptimization,
        '-DSTATIC_HERMES',
        // wit-bindgen emits compiler warnings for generated glue that do not identify guest issues.
        '-w',
        '-mllvm',
        '-wasm-enable-sjlj',
        '-mllvm',
        '-wasm-use-legacy-eh=false',
        `-I${generated}`,
        '-o',
        bindingsObject,
        path.join(generated, 'plugin.c')
    ]);
    // C++ exceptions carry shim failures back into JavaScript error handling.
    run(cxx, [
        '-c',
        ...nativeOptimization,
        '-DSTATIC_HERMES',
        // JSI host-function exceptions are translated into catchable JavaScript exceptions.
        '-fwasm-exceptions',
        '-mllvm',
        '-wasm-use-legacy-eh=false',
        ...includeFlags,
        `-I${generated}`,
        `-I${generatedApiDir}`,
        '-o',
        shimObject,
        path.join(runtimeRoot, 'native/runtime.cpp')
    ]);
    run(cxx, [
        ...nativeOptimization,
        '-DSTATIC_HERMES',
        '-fwasm-exceptions',
        '-mllvm',
        '-wasm-use-legacy-eh=false',
        // Make stack overflow checks trap, reserve the configured guest stack, and link as a component reactor.
        '-Wl,--stack-first',
        `-Wl,-z,stack-size=${stackSizeBytes}`,
        '-mexec-model=reactor',
        // Remove unreferenced code; production also removes symbols and debug data.
        '-Wl,--gc-sections',
        ...(developmentMode ? [] : ['-Wl,--strip-all']),
        '-o',
        output,
        componentType,
        unitObject,
        bindingsObject,
        shimObject,
        path.join(hermesWasiBuild, 'jsi/libjsi.a'),
        hermesRuntimeArchive,
        // Required exception and wasi-libc emulation support for the selected Hermes build.
        '-lsetjmp',
        '-lwasi-emulated-mman',
        '-lwasi-emulated-process-clocks',
        '-lc++abi',
        '-lunwind'
    ]);
} finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
}
