import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHermes } from '../hermes/prepare.ts';
import { setupHermesToolchainEnvironment } from '../hermes/toolchain-environment.ts';
import { hermesHostCompilerPath } from '../hermes/toolchain-paths.ts';
import { analyzeComponentWit } from './analyze.ts';
import { compileAndLinkComponent } from './compile.ts';
import { generateComponentFiles } from './generate.ts';
import type { ComponentBuildOptions } from './types.ts';

const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Analyze WIT, generate adapters, compile Hermes bytecode, and link one component.
 *
 * @param options - Bundle, WIT world, output, runtime profile, and operation selections.
 * @returns A promise that resolves after the component has been compiled and linked.
 * @throws {Error} If required toolchain setup, WIT analysis, compilation, or linking fails.
 */
export async function buildStaticHermesComponent(options: ComponentBuildOptions): Promise<void> {
    const workspaceRoot = path.resolve(options.workspaceRoot ?? path.dirname(options.output));
    const environment = process.env;
    const toolchain = await setupHermesToolchainEnvironment({
        workspaceRoot,
        env: environment,
        includeWasiSdk: true,
        includeWitBindgen: true,
        includeWasmTools: true
    });
    Object.assign(environment, toolchain);
    if (environment.PUMPKIN_PLUGINS_STATIC_HERMES_PREPARED !== '1') {
        await prepareHermes({ workspaceRoot, environment });
    }

    const analysis = analyzeComponentWit(options);
    const runtimeVariant =
        options.runtimeVariant ?? (environment.STATIC_HERMES_ENABLE_LEAN_ARCHIVE === '0' ? 'full' : 'lean');
    const stackSizeBytes = environment.STATIC_HERMES_STACK_SIZE ?? '262144';
    validateRuntimeVariant(runtimeVariant);
    validateStackSize(stackSizeBytes);

    const cacheRoot = configuredPath(environment, 'STATIC_HERMES_CACHE_DIR', path.join(workspaceRoot, '.cache/hermes'));
    const hermesSource = configuredPath(environment, 'STATIC_HERMES_SOURCE_DIR', path.join(cacheRoot, 'source'));
    const hermesHostBuild = configuredPath(
        environment,
        'STATIC_HERMES_HOST_BUILD_DIR',
        path.join(cacheRoot, 'build-host')
    );
    const hermesWasiBuild = configuredPath(
        environment,
        'STATIC_HERMES_WASI_BUILD_DIR',
        path.join(cacheRoot, 'build-wasip2')
    );
    const wasiSdk = configuredEnvironmentPath(environment, 'STATIC_HERMES_WASI_SDK_PATH');
    const bindgen = configuredEnvironmentPath(environment, 'WIT_BINDGEN');
    const hermesRuntimeArchive = path.join(
        hermesWasiBuild,
        `lib/libhermesvm${runtimeVariant === 'lean' ? 'lean' : ''}_a.a`
    );
    const hermesc = hermesHostCompilerPath(hermesHostBuild);
    requirePath('Hermes source', hermesSource);
    requirePath('Hermes host compiler', hermesc);
    requirePath(`WASI Hermes ${runtimeVariant} runtime archive`, hermesRuntimeArchive);
    requirePath('WASI Hermes JSI archive', path.join(hermesWasiBuild, 'jsi/libjsi.a'));
    requirePath('wit-bindgen', bindgen);

    const temporaryDirectory = fs.mkdtempSync(path.join(path.dirname(options.output), '.static-hermes-'));
    try {
        const generated = generateComponentFiles({
            witDirectory: options.wit,
            bundlePath: options.bundle,
            templatePath: path.join(runtimeRoot, 'src/component/templates/runtime-shim.template'),
            outputDirectory: temporaryDirectory,
            bindgenPath: bindgen,
            analysis
        });
        compileAndLinkComponent({
            options,
            generated,
            temporaryDirectory,
            stackSizeBytes,
            toolchain: { hermesSource, hermesWasiBuild, hermesRuntimeArchive, hermesc, wasiSdk }
        });
    } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
}

function configuredPath(environment: NodeJS.ProcessEnv, name: string, fallback: string): string {
    return path.resolve(environment[name] ?? fallback);
}

function configuredEnvironmentPath(environment: NodeJS.ProcessEnv, name: string): string {
    const value = environment[name];
    if (!value) throw new Error(`${name} is not configured by Static Hermes toolchain setup`);
    return path.resolve(value);
}

function requirePath(description: string, filename: string): void {
    if (!fs.existsSync(filename)) {
        throw new Error(
            `${description} not found at ${filename}; run prepare-hermes first (see tools/static-hermes-runtime/README.md)`
        );
    }
}

function validateRuntimeVariant(value: string): asserts value is 'full' | 'lean' {
    if (value !== 'full' && value !== 'lean') throw new Error('--runtime-variant must be "full" or "lean"');
}

function validateStackSize(value: string): void {
    if (!/^\d+$/.test(value) || Number(value) < 131072 || Number(value) % 16 !== 0) {
        throw new Error('STATIC_HERMES_STACK_SIZE must be a multiple of 16 and at least 131072 bytes');
    }
}
