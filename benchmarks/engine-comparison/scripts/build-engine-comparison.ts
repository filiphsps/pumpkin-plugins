import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { readParseTypeScript } from '../src/build-log.ts';
import {
    createEngineComparisonMatrix,
    createEngineVariants,
    getEngineVariantBuildOutput,
} from '../src/engine-variants.ts';

const benchmarkDir = path.resolve(import.meta.dirname, '..');
const repositoryDir = path.resolve(benchmarkDir, '../..');
const buildCli = path.join(repositoryDir, 'tools/build/dist/cli.js');
const apiRoot = path.dirname(createRequire(import.meta.url).resolve('@pumpkin-plugins/pumpkin-api/package.json'));
const cacheDir = path.join(repositoryDir, '.cache');
const hermesCacheDir = process.env.STATIC_HERMES_CACHE_DIR ?? path.join(cacheDir, 'hermes');
const stackGuardSource = path.join(benchmarkDir, 'test/fixtures/stack-guard-plugin.ts');
const requestedVariantId = process.env.ENGINE_COMPARISON_VARIANT;
const comparisonVariants = createEngineVariants();
const comparisonMatrix = createEngineComparisonMatrix();
const selectedMatrixEntry = comparisonMatrix.find(({ variant }) => variant === requestedVariantId);
const selectedVariant =
    selectedMatrixEntry?.kind === 'benchmark'
        ? comparisonVariants.find(({ id }) => id === selectedMatrixEntry.variant)
        : undefined;
const selectedStackGuard = selectedMatrixEntry?.kind === 'stack-guard' ? selectedMatrixEntry : undefined;

if (requestedVariantId && !selectedMatrixEntry) {
    throw new Error(`Unknown engine comparison variant: ${requestedVariantId}`);
}

fs.mkdirSync(cacheDir, { recursive: true });
const temporaryDir = fs.mkdtempSync(path.join(cacheDir, 'engine-comparison-build-'));

try {
    const variantsToBuild = selectedVariant ? [selectedVariant] : requestedVariantId ? [] : comparisonVariants;
    for (const variant of variantsToBuild) {
        const packageDir = path.join(temporaryDir, variant.id);
        const sourceDir = path.join(packageDir, 'src');
        createBuildPackage(packageDir, `runtime-benchmark-${variant.id}`, {
            entry: 'src/plugin.ts',
            output: 'build/plugin.wasm',
            engine: variant.pluginEngine,
            wasi: [],
            ...(variant.staticHermesRuntime ? { staticHermesRuntime: variant.staticHermesRuntime } : {}),
            ...(variant.staticHermesGc ? { staticHermesGc: variant.staticHermesGc } : {}),
        });
        fs.copyFileSync(path.join(benchmarkDir, 'src/benchmark-plugin.ts'), path.join(sourceDir, 'plugin.ts'));
        fs.copyFileSync(
            path.join(benchmarkDir, 'src/benchmark-workloads.ts'),
            path.join(sourceDir, 'benchmark-workloads.ts'),
        );
        fs.cpSync(path.join(benchmarkDir, 'src/workloads'), path.join(sourceDir, 'workloads'), { recursive: true });

        const wasmPath = buildPlugin(packageDir, variant.label, variant.parseTypeScript, false);
        publishComponent(wasmPath, getEngineVariantBuildOutput(benchmarkDir, variant.id));
    }

    const stackGuardEntries = selectedStackGuard
        ? [selectedStackGuard]
        : requestedVariantId
          ? []
          : comparisonMatrix.filter(
                (entry): entry is Extract<typeof entry, { kind: 'stack-guard' }> => entry.kind === 'stack-guard',
            );
    for (const { runtime: runtimeVariant, variant: id } of stackGuardEntries) {
        const packageDir = path.join(temporaryDir, id);
        const sourceDir = path.join(packageDir, 'src');
        createBuildPackage(packageDir, `runtime-benchmark-${id}`, {
            entry: 'src/plugin.ts',
            output: 'build/plugin.wasm',
            engine: 'static-hermes',
            staticHermesRuntime: runtimeVariant,
            wasi: [],
        });
        fs.copyFileSync(stackGuardSource, path.join(sourceDir, 'plugin.ts'));

        const wasmPath = buildPlugin(packageDir, `Static Hermes ${runtimeVariant} stack guard`, false, true);
        publishComponent(wasmPath, getEngineVariantBuildOutput(benchmarkDir, id));
    }
} finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
}

function createBuildPackage(packageDir: string, name: string, pumpkinPlugin: Record<string, unknown>): void {
    const sourceDir = path.join(packageDir, 'src');
    const apiLink = path.join(packageDir, 'node_modules/@pumpkin-plugins/pumpkin-api');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(path.dirname(apiLink), { recursive: true });
    fs.symlinkSync(apiRoot, apiLink, process.platform === 'win32' ? 'junction' : 'dir');
    fs.writeFileSync(
        path.join(packageDir, 'package.json'),
        `${JSON.stringify({ name, version: '0.0.0', dependencies: { '@pumpkin-plugins/pumpkin-api': `link:${apiRoot}` }, pumpkinPlugin }, null, 2)}\n`,
    );
    fs.writeFileSync(
        path.join(packageDir, 'tsconfig.json'),
        `${JSON.stringify(
            {
                compilerOptions: {
                    target: 'ES2022',
                    module: 'ESNext',
                    moduleResolution: 'Bundler',
                    strict: true,
                    types: [],
                },
                include: ['src/**/*.ts'],
            },
            null,
            2,
        )}\n`,
    );
}

function buildPlugin(packageDir: string, label: string, parseTypeScript: boolean, developmentMode: boolean): string {
    const buildArgs = [buildCli, ...(parseTypeScript ? ['--parse-ts'] : [])];
    const buildOutput = execFileSync(process.execPath, buildArgs, {
        cwd: packageDir,
        encoding: 'utf8',
        env: {
            ...process.env,
            PUMPKIN_DEV_MODE: developmentMode ? '1' : '0',
            PUMPKIN_PLUGINS_BUILD_LOG_FORMAT: 'json',
            STATIC_HERMES_CACHE_DIR: hermesCacheDir,
        },
        maxBuffer: 16 * 1024 * 1024,
    });
    console.log(`${label} build:\n${buildOutput.trim()}`);
    if (readParseTypeScript(buildOutput) !== parseTypeScript) {
        throw new Error(`${label} build selected an unexpected parser mode`);
    }
    return path.join(packageDir, 'build/plugin.wasm');
}

function publishComponent(source: string, target: string): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
}
