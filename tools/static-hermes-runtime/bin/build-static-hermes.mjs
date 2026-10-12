#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrapBundleForDiagnostics } from './bundle-diagnostics.mjs';
import { parseJsonStringArray } from './cli-arguments.mjs';
import { renderEmbeddedBytecode } from './embed-bytecode.mjs';
import { prepareStaticHermesBuild } from './toolchain-environment.mjs';
import { wasiFeaturesForMethods } from './wit-api.mjs';

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
const wasiImports = parseJsonStringArray(args.get('wasi-imports') ?? '[]', 'wasi-imports', 'module specifiers');
const wasiMethods = parseJsonStringArray(args.get('wasi-methods'), 'wasi-methods', 'WASI method identifiers');
const wasiFeatures = wasiFeaturesForMethods(witDir, wasiMethods);
const apiMethods = parseJsonStringArray(args.get('api-methods'), 'api-methods', 'method identifiers');
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
const hermesc = path.join(hermesHostBuild, 'bin', 'hermesc');
const tempDir = fs.mkdtempSync(path.join(path.dirname(output), '.static-hermes-'));

/** Read a required command-line path and resolve it against the current directory. */
function required(name) {
    const value = args.get(name);
    if (!value) throw new Error(`Missing --${name}`);
    return path.resolve(value);
}

/** Resolve a configured environment path or its fallback. */
function configuredPath(name, fallback) {
    return path.resolve(process.env[name] ?? fallback);
}

/** Ensure a required build input exists and provide setup guidance when it does not. */
function requirePath(description, location) {
    if (!fs.existsSync(location)) {
        throw new Error(
            `${description} not found at ${location}; run prepare-hermes first (see tools/static-hermes-runtime/README.md)`
        );
    }
}

/** Run a build command while forwarding its standard streams to the terminal. */
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
    const unitBytecode = path.join(tempDir, 'plugin_bundle.hbc');
    const bytecodeHeader = path.join(tempDir, 'plugin-bytecode.generated.h');
    const bindingsObject = path.join(tempDir, 'plugin.o');
    const shimObject = path.join(tempDir, 'runtime.o');
    const runtimeCpp = path.join(tempDir, 'runtime.cpp');
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
    // Each plugin build has a distinct WIT world, so keep its generated enum header beside its
    // other temporary bindings instead of sharing a package-level header across parallel builds.
    const generatedApiDir = path.join(tempDir, 'generated');

    fs.mkdirSync(generated, { recursive: true });
    run(bindgen, [
        'c',
        witDir,
        '--world',
        'plugin',
        ...(wasiFeatures.length === 0 ? [] : ['--features', wasiFeatures.join(',')]),
        '--out-dir',
        generated
    ]);
    run(process.execPath, [
        path.join(runtimeRoot, 'bin/generate-api-enums.mjs'),
        '--wit',
        witDir,
        '--bundle',
        bundle,
        '--header',
        path.join(generated, 'plugin.h'),
        '--output',
        path.join(generatedApiDir, 'api-enums.generated.h')
    ]);
    run(process.execPath, [
        path.join(runtimeRoot, 'bin/generate-runtime.mjs'),
        '--wit',
        witDir,
        '--bundle',
        bundle,
        '--template',
        path.join(runtimeRoot, 'bin/templates/runtime-shim.template'),
        '--wasi-imports',
        JSON.stringify(wasiImports),
        ...(wasiMethods === undefined ? [] : ['--wasi-methods', JSON.stringify(wasiMethods)]),
        ...(apiMethods === undefined ? [] : ['--api-methods', JSON.stringify(apiMethods)]),
        '--output',
        runtimeCpp
    ]);
    // Hermes bytecode keeps source locations for JavaScript backtraces in development builds.
    const hermesOptimization = developmentMode ? ['-Og', '-g1'] : ['-O4', '-fstrip-function-names', '-g0'];
    // Keep development line tables and function names while minimizing native code and allowing linker GC.
    const nativeOptimization = developmentMode
        ? ['-Oz', '-gline-tables-only', '-DNDEBUG', '-ffunction-sections', '-fdata-sections']
        : ['-Oz', '-DNDEBUG', '-ffunction-sections', '-fdata-sections'];
    // Always request compiler colors so captured build logs retain readable diagnostics.
    fs.writeFileSync(bundle, wrapBundleForDiagnostics(fs.readFileSync(bundle, 'utf8')));
    run(hermesc, ['-color', ...hermesOptimization, '-emit-binary', `-out=${unitBytecode}`, bundle]);
    fs.writeFileSync(bytecodeHeader, renderEmbeddedBytecode(fs.readFileSync(unitBytecode)));

    const includeFlags = hermesIncludes.map((include) => `-I${include}`);
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
        runtimeCpp
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
