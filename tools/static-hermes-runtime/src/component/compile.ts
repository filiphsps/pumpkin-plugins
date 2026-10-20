import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { wasiSdkCompilerPath } from '../hermes/toolchain-paths.ts';
import { wrapBundleForDiagnostics } from './bundle-diagnostics.ts';
import { renderEmbeddedBytecode } from './embed-bytecode.ts';
import type { ComponentGeneratedFiles } from './generate.ts';
import type { ComponentBuildOptions } from './types.ts';

/** Paths to the Hermes and WASI SDK artifacts required to compile a component. */
export interface ComponentToolchainArtifacts {
    /** Host executable that converts the bundle to Hermes bytecode. */
    hermesc: string;
    /** Selected full or lean Hermes archive for this component. */
    hermesRuntimeArchive: string;
    /** Pinned Hermes source checkout used for its public and internal headers. */
    hermesSource: string;
    /** Hermes build directory containing WASI libraries and configuration headers. */
    hermesWasiBuild: string;
    /** Installed WASI SDK root containing the `wasm32-wasip2` compiler. */
    wasiSdk: string;
}

/** Inputs for compiling generated bindings and bytecode into a WASI component. */
export interface ComponentCompilationInput {
    /** Generated bindings and runtime source produced for the resolved WIT world. */
    generated: ComponentGeneratedFiles;
    /** Component build settings, including source, destination, and runtime profile. */
    options: ComponentBuildOptions;
    /** Optional command runner, primarily for tests that inspect compiler invocations. */
    run?: (command: string, args: string[]) => void;
    /** Component stack size in bytes, passed to the linker. */
    stackSizeBytes: string;
    /** Temporary directory for bytecode and native object files. */
    temporaryDirectory: string;
    /** Hermes and WASI SDK locations used by the compiler and linker. */
    toolchain: ComponentToolchainArtifacts;
}

/**
 * Compile Hermes bytecode and native bindings, then link the final component.
 *
 * @param input - Component settings, generated files, toolchain paths, and optional command runner.
 */
export function compileAndLinkComponent(input: ComponentCompilationInput): void {
    const { options, generated, temporaryDirectory, stackSizeBytes, toolchain } = input;
    const run = input.run ?? ((command, args) => execFileSync(command, args, { stdio: 'inherit' }));
    const unitBytecode = path.join(temporaryDirectory, 'plugin_bundle.hbc');
    const diagnosticBundle = path.join(temporaryDirectory, 'plugin_bundle.js');
    const bytecodeHeader = path.join(temporaryDirectory, 'plugin-bytecode.generated.h');
    const bindingsObject = path.join(temporaryDirectory, 'plugin.o');
    const shimObject = path.join(temporaryDirectory, 'runtime.o');
    const compiler = wasiSdkCompilerPath(toolchain.wasiSdk, 'wasm32-wasip2-clang');
    const cxx = wasiSdkCompilerPath(toolchain.wasiSdk, 'wasm32-wasip2-clang++');
    const hermesIncludes = [
        path.join(toolchain.hermesSource, 'include'),
        path.join(toolchain.hermesSource, 'public'),
        path.join(toolchain.hermesSource, 'API'),
        path.join(toolchain.hermesSource, 'API/jsi'),
        path.join(toolchain.hermesSource, 'API/jsi/jsi'),
        path.join(toolchain.hermesSource, 'external/llvh/include'),
        path.join(toolchain.hermesWasiBuild, 'include'),
        path.join(toolchain.hermesWasiBuild, 'lib/config'),
    ];
    const hermesOptimization = options.developmentMode ? ['-Og', '-g1'] : ['-O4', '-fstrip-function-names', '-g0'];
    const nativeOptimization = options.developmentMode
        ? ['-Oz', '-gline-tables-only', '-DNDEBUG', '-ffunction-sections', '-fdata-sections']
        : ['-Oz', '-DNDEBUG', '-ffunction-sections', '-fdata-sections'];

    fs.writeFileSync(diagnosticBundle, wrapBundleForDiagnostics(fs.readFileSync(options.bundle, 'utf8')));
    run(toolchain.hermesc, [
        '-color',
        ...(options.parseTypeScript ? ['-parse-ts'] : []),
        ...hermesOptimization,
        '-emit-binary',
        `-out=${unitBytecode}`,
        diagnosticBundle,
    ]);
    fs.writeFileSync(
        bytecodeHeader,
        renderEmbeddedBytecode(path.basename(unitBytecode), fs.statSync(unitBytecode).size),
    );

    const includeFlags = hermesIncludes.map((include) => `-I${include}`);
    run(compiler, [
        '-c',
        ...nativeOptimization,
        '-DSTATIC_HERMES',
        '-w',
        '-mllvm',
        '-wasm-enable-sjlj',
        '-mllvm',
        '-wasm-use-legacy-eh=false',
        `-I${generated.directory}`,
        '-o',
        bindingsObject,
        generated.pluginC,
    ]);
    run(cxx, [
        '-c',
        ...nativeOptimization,
        '-DSTATIC_HERMES',
        '-fwasm-exceptions',
        '-mllvm',
        '-wasm-use-legacy-eh=false',
        ...includeFlags,
        `-I${generated.directory}`,
        `-I${temporaryDirectory}`,
        '-o',
        shimObject,
        generated.runtimeSource,
    ]);
    run(cxx, [
        ...nativeOptimization,
        '-DSTATIC_HERMES',
        '-fwasm-exceptions',
        '-mllvm',
        '-wasm-use-legacy-eh=false',
        '-Wl,--stack-first',
        `-Wl,-z,stack-size=${stackSizeBytes}`,
        '-mexec-model=reactor',
        '-Wl,--gc-sections',
        ...(options.developmentMode ? [] : ['-Wl,--strip-all']),
        '-o',
        options.output,
        generated.componentType,
        bindingsObject,
        shimObject,
        path.join(toolchain.hermesWasiBuild, 'jsi/libjsi.a'),
        toolchain.hermesRuntimeArchive,
        '-lsetjmp',
        '-lwasi-emulated-mman',
        '-lwasi-emulated-process-clocks',
        '-lc++abi',
        '-lunwind',
    ]);
}
