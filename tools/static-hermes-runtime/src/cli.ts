#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Command, Option } from '@commander-js/extra-typings';
import { buildStaticHermesComponent } from './component/build.ts';
import type { ComponentBuildOptions } from './component/types.ts';
import { buildHermesArtifacts, patchHermesSource, prepareHermes, prepareHermesSource } from './hermes/prepare.ts';
import { setupHermesToolchainEnvironment } from './hermes/toolchain-environment.ts';
import { analyzeWitUsage } from './wit/analysis.ts';
import { generateWitOutputs, writeWitGeneration } from './wit/generation.ts';
import { readInterfaceDeclarationOrder, readPluginImportOrder, readWitToolsDocument } from './wit/parser.ts';
import { resolvePluginApi, resolveWitDocument } from './wit/resolver.ts';

const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(runtimeRoot, '../..');

/** WIT inputs and selections shared by the analyze and generate commands. */
export interface CodegenSelectionOptions {
    /** Directory containing the prepared plugin WIT world. */
    wit: string;
    /** Bundled JavaScript source scanned for used operations and event fields. */
    bundle: string;
    /** WASI interface specifiers explicitly selected for adapter generation. */
    wasiImports: string[];
    /** Optional fully qualified WASI operation identifiers to include. */
    wasiMethods?: string[];
    /** Optional fully qualified Pumpkin API operation identifiers to include. */
    apiMethods?: string[];
}

/** Additional file paths needed to generate runtime sources. */
export interface CodegenGenerateOptions extends CodegenSelectionOptions {
    /** C++ runtime template containing the generator marker comments. */
    template: string;
    /** Generated plugin header used to determine required enum declarations. */
    header: string;
    /** Destination directory for generated runtime source and enum header. */
    outDir: string;
}

/** Injectable command handlers for tests and CLI composition. */
export interface StaticHermesCliDependencies {
    /** Ensure the pinned Hermes source checkout exists. */
    hermesSource(): Promise<void> | void;
    /** Apply the configured Hermes patch series. */
    hermesPatch(): Promise<void> | void;
    /** Build or reuse the host compiler and WASI Hermes archives. */
    hermesBuild(): Promise<void> | void;
    /** Run source, patch, and build preparation in sequence. */
    hermesPrepare(): Promise<void> | void;
    /** Handle the `codegen analyze` command. */
    analyze(options: CodegenSelectionOptions): Promise<void> | void;
    /** Handle the `codegen generate` command. */
    generate(options: CodegenGenerateOptions): Promise<void> | void;
    /** Handle the `component build` command. */
    componentBuild(options: ComponentBuildOptions): Promise<void> | void;
}

/**
 * Construct the Hermes preparation, WIT code-generation, and component-build commands.
 *
 * @param dependencies - Handlers invoked by each command; omitted to use the production implementations.
 * @returns The configured Commander program.
 */
export function createStaticHermesProgram(dependencies: StaticHermesCliDependencies = defaultDependencies()): Command {
    const program = new Command()
        .name('static-hermes-runtime')
        .description('Prepare and build Pumpkin Static Hermes components')
        .showHelpAfterError();

    const hermes = program.command('hermes').description('Manage the pinned Hermes source and build');
    hermes
        .command('source')
        .description('Create or validate the pinned Hermes source checkout')
        .addHelpText('after', '\nUses STATIC_HERMES_SOURCE_DIR or the configured cache source directory.\n')
        .action(dependencies.hermesSource);
    hermes.command('patch').description('Apply the ordered Hermes patch series').action(dependencies.hermesPatch);
    hermes.command('build').description('Build the host compiler and WASI archives').action(dependencies.hermesBuild);
    hermes.command('prepare').description('Run source, patch, and build stages').action(dependencies.hermesPrepare);

    const codegen = program.command('codegen').description('Analyze WIT and generate Static Hermes adapters');
    codegen
        .command('analyze')
        .description('Print deterministic WIT usage and adapter analysis')
        .requiredOption('--wit <dir>', 'Prepared WIT directory')
        .requiredOption('--bundle <file>', 'Bundled JavaScript source')
        .option('--wasi-imports <json-array>', 'WASI interface specifiers', '[]')
        .option('--wasi-methods <json-array>', 'Used WASI operation identifiers')
        .option('--api-methods <json-array>', 'Used Pumpkin operation identifiers')
        .action(async (options) => dependencies.analyze(parseCodegenSelection(options)));
    codegen
        .command('generate')
        .description('Generate runtime.cpp and api-enums.generated.h')
        .requiredOption('--wit <dir>', 'Prepared WIT directory')
        .requiredOption('--bundle <file>', 'Bundled JavaScript source')
        .option('--wasi-imports <json-array>', 'WASI interface specifiers', '[]')
        .option('--wasi-methods <json-array>', 'Used WASI operation identifiers')
        .option('--api-methods <json-array>', 'Used Pumpkin operation identifiers')
        .requiredOption('--template <file>', 'Runtime C++ template')
        .requiredOption('--header <file>', 'Generated plugin.h')
        .requiredOption('--out-dir <dir>', 'Generated output directory')
        .action(async (options) => dependencies.generate(parseCodegenGenerate(options)));

    const component = program.command('component').description('Compile and link a Static Hermes component');
    component
        .command('build')
        .description('Build one plugin component')
        .requiredOption('--bundle <file>', 'Bundled JavaScript source')
        .requiredOption('--wit <dir>', 'Prepared WIT directory')
        .requiredOption('--output <file>', 'Output component file')
        .option('--development-mode', 'Keep development symbols and line tables')
        .option('--wasi-imports <json-array>', 'WASI interface specifiers', '[]')
        .option('--wasi-methods <json-array>', 'Used WASI operation identifiers')
        .option('--api-methods <json-array>', 'Used Pumpkin operation identifiers')
        .addOption(new Option('--runtime-variant <variant>', 'Hermes archive profile').choices(['full', 'lean']))
        .action(async (options) => dependencies.componentBuild(parseComponentBuild(options)));

    return program;
}

/**
 * Parse and deduplicate one JSON string-array CLI value.
 *
 * @param json - JSON text supplied to an option, or `undefined` when it was omitted.
 * @param optionName - CLI option name used in validation errors, without the leading `--`.
 * @param itemDescription - Human-readable name for the required array item type.
 * @returns Unique strings in their original order, or `undefined` for an omitted option.
 * @throws {Error} If the value is not valid JSON or is not an array of strings.
 */
export function parseJsonStringArray(
    json: string | undefined,
    optionName: string,
    itemDescription: string
): string[] | undefined {
    if (json === undefined) return undefined;
    let value: unknown;
    try {
        value = JSON.parse(json) as unknown;
    } catch (error) {
        throw new Error(
            `--${optionName} must be a JSON array (${error instanceof Error ? error.message : String(error)})`
        );
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new Error(`--${optionName} must be a JSON array of ${itemDescription}`);
    }
    return [...new Set(value)];
}

function parseCodegenSelection(options: {
    wit: string;
    bundle: string;
    wasiImports: string;
    wasiMethods?: string;
    apiMethods?: string;
}): CodegenSelectionOptions {
    const wasiMethods = parseJsonStringArray(options.wasiMethods, 'wasi-methods', 'WASI method identifiers');
    const apiMethods = parseJsonStringArray(options.apiMethods, 'api-methods', 'method identifiers');
    return {
        wit: path.resolve(options.wit),
        bundle: path.resolve(options.bundle),
        wasiImports: parseJsonStringArray(options.wasiImports, 'wasi-imports', 'module specifiers') ?? [],
        ...(wasiMethods === undefined ? {} : { wasiMethods }),
        ...(apiMethods === undefined ? {} : { apiMethods })
    };
}

function parseCodegenGenerate(options: {
    wit: string;
    bundle: string;
    wasiImports: string;
    wasiMethods?: string;
    apiMethods?: string;
    template: string;
    header: string;
    outDir: string;
}): CodegenGenerateOptions {
    return {
        ...parseCodegenSelection(options),
        template: path.resolve(options.template),
        header: path.resolve(options.header),
        outDir: path.resolve(options.outDir)
    };
}

function parseComponentBuild(options: {
    bundle: string;
    wit: string;
    output: string;
    developmentMode?: boolean;
    wasiImports: string;
    wasiMethods?: string;
    apiMethods?: string;
    runtimeVariant?: 'full' | 'lean';
}): ComponentBuildOptions {
    const wasiMethods = parseJsonStringArray(options.wasiMethods, 'wasi-methods', 'WASI method identifiers');
    const apiMethods = parseJsonStringArray(options.apiMethods, 'api-methods', 'method identifiers');
    return {
        bundle: path.resolve(options.bundle),
        wit: path.resolve(options.wit),
        output: path.resolve(options.output),
        developmentMode: options.developmentMode ?? false,
        wasiImports: parseJsonStringArray(options.wasiImports, 'wasi-imports', 'module specifiers') ?? [],
        ...(wasiMethods === undefined ? {} : { wasiMethods }),
        ...(apiMethods === undefined ? {} : { apiMethods }),
        ...(options.runtimeVariant === undefined ? {} : { runtimeVariant: options.runtimeVariant })
    };
}

async function runAnalysis(options: CodegenSelectionOptions): Promise<void> {
    const { analysis } = await analyzeCodegen(options);
    console.log(
        JSON.stringify(
            {
                apiInterfaces: analysis.apiInterfaces,
                apiMethods: analysis.apiMethods,
                wasiImports: analysis.wasiImports,
                wasiInterfaces: analysis.wasiInterfaces,
                wasiMethods: analysis.wasiMethods,
                wasiFeatures: analysis.wasiFeatures,
                wasiAdapters: analysis.wasiAdapters.map(({ operationId, kind }) => ({ operationId, kind })),
                eventFields: analysis.eventFields
            },
            null,
            2
        )
    );
}

async function analyzeCodegen(options: CodegenSelectionOptions) {
    await ensureWasmTools();
    const document = readWitToolsDocument(options.wit);
    const imports = readPluginImportOrder(options.wit);
    const resolved = resolveWitDocument(document, readInterfaceDeclarationOrder(options.wit));
    const bundleSource = fs.readFileSync(options.bundle, 'utf8');
    const apiPackage = resolvePluginApi(resolved, imports);
    const analysis = analyzeWitUsage(resolved, {
        bundleSource,
        pluginImportOrder: imports,
        wasiImports: options.wasiImports,
        ...(options.wasiMethods === undefined ? {} : { wasiMethods: options.wasiMethods }),
        ...(options.apiMethods === undefined ? {} : { apiMethods: options.apiMethods })
    });
    return { analysis, apiPackage, bundleSource };
}

async function runGeneration(options: CodegenGenerateOptions): Promise<void> {
    const { analysis, apiPackage, bundleSource } = await analyzeCodegen({
        wit: options.wit,
        bundle: options.bundle,
        wasiImports: options.wasiImports,
        ...(options.wasiMethods === undefined ? {} : { wasiMethods: options.wasiMethods }),
        ...(options.apiMethods === undefined ? {} : { apiMethods: options.apiMethods })
    });
    const output = generateWitOutputs({
        analysis,
        apiPackage,
        wasiInterfaces: analysis.resolvedWasiInterfaces,
        bundleSource,
        pluginHeader: fs.readFileSync(options.header, 'utf8'),
        runtimeTemplate: fs.readFileSync(options.template, 'utf8')
    });
    writeWitGeneration(options.outDir, output);
}

async function runComponentBuild(options: ComponentBuildOptions): Promise<void> {
    await buildStaticHermesComponent(options);
}

let setupWasmTools: Promise<void> | undefined;
async function ensureWasmTools(): Promise<void> {
    if (process.env.WASM_TOOLS) return;
    setupWasmTools ??= (async () => {
        Object.assign(
            process.env,
            await setupHermesToolchainEnvironment({
                workspaceRoot,
                includeWasiSdk: false,
                includeWitBindgen: false,
                includeWasmTools: true
            })
        );
    })();
    await setupWasmTools;
}

function defaultDependencies(): StaticHermesCliDependencies {
    return {
        hermesSource: async () => {
            await prepareHermesSource();
        },
        hermesPatch: () => patchHermesSource(),
        hermesBuild: () => buildHermesArtifacts(),
        hermesPrepare: () => prepareHermes(),
        analyze: runAnalysis,
        generate: runGeneration,
        componentBuild: runComponentBuild
    };
}

/**
 * Parse and run the Static Hermes CLI.
 *
 * @param args - Full process arguments, or user arguments when supplied separately.
 */
export async function runStaticHermesCli(args: readonly string[] = process.argv): Promise<void> {
    const program = createStaticHermesProgram();
    if (args === process.argv) await program.parseAsync([...args]);
    else await program.parseAsync([...args], { from: 'user' });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    runStaticHermesCli().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    });
}
