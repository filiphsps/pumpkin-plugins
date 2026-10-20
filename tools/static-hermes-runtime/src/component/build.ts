import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermesWasiBuildDirectory } from '../hermes/gc.ts';
import { prepareHermes } from '../hermes/prepare.ts';
import { setupHermesToolchainEnvironment } from '../hermes/toolchain-environment.ts';
import { hermesHostCompilerPath } from '../hermes/toolchain-paths.ts';
import { readInterfaceDeclarationOrder, readPluginImportOrder } from '../wit/parser.ts';
import { resolveConsumerWorkspaceRoot } from '../workspace-root.ts';
import { analyzeComponentWit } from './analyze.ts';
import { compileAndLinkComponent } from './compile.ts';
import { generateComponentFiles } from './generate.ts';
import type { ComponentBuildOptions } from './types.ts';

const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const maximumStackSizeBytes = 0xffff_fff0;

/**
 * Analyze WIT, generate adapters, compile Hermes bytecode, and link one component.
 *
 * @param options - Bundle, WIT world, output, runtime profile, and operation selections.
 * @returns A promise that resolves after the component has been compiled and linked.
 * @throws {Error} If required toolchain setup, WIT analysis, compilation, or linking fails.
 */
export async function buildComponent(options: ComponentBuildOptions): Promise<void> {
    const environment = process.env;
    const runtimeVariant =
        options.runtimeVariant ?? (environment.STATIC_HERMES_ENABLE_LEAN_ARCHIVE === '0' ? 'full' : 'lean');
    const gcVariant = options.gcVariant ?? 'hades';
    const stackSizeBytes = environment.STATIC_HERMES_STACK_SIZE ?? '262144';
    validateRuntimeVariant(runtimeVariant);
    validateGcVariant(gcVariant);
    validateStackSize(stackSizeBytes);
    preflightComponentInputs(options);
    const outputDirectory = path.dirname(options.output);
    fs.mkdirSync(outputDirectory, { recursive: true });

    const workspaceRoot = resolveConsumerWorkspaceRoot(options.workspaceRoot);
    const toolchain = await setupHermesToolchainEnvironment({
        workspaceRoot,
        env: environment,
        includeWasiSdk: true,
        includeWitBindgen: true,
        includeWasmTools: true,
    });
    Object.assign(environment, toolchain);
    const analysis = analyzeComponentWit(options);

    const cacheRoot = configuredPath(environment, 'STATIC_HERMES_CACHE_DIR', path.join(workspaceRoot, '.cache/hermes'));
    const hermesSource = configuredPath(environment, 'STATIC_HERMES_SOURCE_DIR', path.join(cacheRoot, 'source'));
    const hermesHostBuild = configuredPath(
        environment,
        'STATIC_HERMES_HOST_BUILD_DIR',
        path.join(cacheRoot, 'build-host'),
    );
    const hermesWasiBuild = hermesWasiBuildDirectory(cacheRoot, environment, gcVariant);
    const wasiSdk = configuredEnvironmentPath(environment, 'STATIC_HERMES_WASI_SDK_PATH');
    const bindgen = configuredEnvironmentPath(environment, 'WIT_BINDGEN');
    const hermesRuntimeArchive = path.join(
        hermesWasiBuild,
        `lib/libhermesvm${runtimeVariant === 'lean' ? 'lean' : ''}_a.a`,
    );
    const hermesJsiArchive = path.join(hermesWasiBuild, 'jsi/libjsi.a');
    if (
        environment.PUMPKIN_PLUGINS_STATIC_HERMES_PREPARED !== '1' ||
        !fs.existsSync(hermesRuntimeArchive) ||
        !fs.existsSync(hermesJsiArchive)
    ) {
        await prepareHermes({ workspaceRoot, environment, gcVariant });
    }
    const hermesc = hermesHostCompilerPath(hermesHostBuild);
    requirePath('Hermes source', hermesSource);
    requirePath('Hermes host compiler', hermesc);
    requirePath(`WASI Hermes ${runtimeVariant} runtime archive`, hermesRuntimeArchive);
    requirePath('WASI Hermes JSI archive', hermesJsiArchive);
    requirePath('wit-bindgen', bindgen);

    const temporaryDirectory = fs.mkdtempSync(path.join(outputDirectory, '.static-hermes-'));
    let preserveTemporaryDirectory = false;
    try {
        const generated = generateComponentFiles({
            witDirectory: options.wit,
            templatePath: path.join(runtimeRoot, 'src/component/templates/runtime-shim.template'),
            outputDirectory: temporaryDirectory,
            bindgenPath: bindgen,
            analysis,
        });
        const componentOutput = path.join(temporaryDirectory, 'component.wasm');
        compileAndLinkComponent({
            options: { ...options, output: componentOutput },
            generated,
            temporaryDirectory,
            stackSizeBytes,
            toolchain: { hermesSource, hermesWasiBuild, hermesRuntimeArchive, hermesc, wasiSdk },
        });
        publishComponent(componentOutput, options.output, temporaryDirectory, () => {
            preserveTemporaryDirectory = true;
        });
    } finally {
        if (!preserveTemporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
}

function preflightComponentInputs(options: ComponentBuildOptions): void {
    readPluginImportOrder(options.wit);
    readInterfaceDeclarationOrder(options.wit);
    fs.readFileSync(options.bundle, 'utf8');
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
            `${description} not found at ${filename}; run prepare-hermes first (see tools/static-hermes-runtime/README.md)`,
        );
    }
}

function validateRuntimeVariant(value: string): asserts value is 'full' | 'lean' {
    if (value !== 'full' && value !== 'lean') throw new Error('--runtime-variant must be "full" or "lean"');
}

function validateGcVariant(value: string): void {
    if (value !== 'hades' && value !== 'malloc') throw new Error('--gc-variant must be "hades" or "malloc"');
}

function validateStackSize(value: string): void {
    const stackSizeBytes = Number(value);
    if (
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(stackSizeBytes) ||
        stackSizeBytes < 131072 ||
        stackSizeBytes > maximumStackSizeBytes ||
        stackSizeBytes % 16 !== 0
    ) {
        throw new Error(
            `STATIC_HERMES_STACK_SIZE must be a multiple of 16 and between 131072 and ${maximumStackSizeBytes} bytes`,
        );
    }
}

function publishComponent(
    component: string,
    output: string,
    temporaryDirectory: string,
    preserveForRecovery: () => void,
): void {
    try {
        fs.renameSync(component, output);
    } catch (error) {
        if (!isReplaceError(error) || !fs.existsSync(output)) throw error;
        const existing = fs.lstatSync(output);
        if (!existing.isFile() && !existing.isSymbolicLink()) throw error;

        const previous = path.join(temporaryDirectory, 'previous.wasm');
        fs.renameSync(output, previous);
        try {
            fs.renameSync(component, output);
        } catch (publishError) {
            try {
                fs.renameSync(previous, output);
            } catch (restoreError) {
                preserveForRecovery();
                throw new AggregateError(
                    [publishError, restoreError],
                    `could not publish or restore ${output}; previous artifact preserved at ${previous}`,
                );
            }
            throw publishError;
        }
    }
}

function isReplaceError(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'EACCES')
    );
}
