import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { createEngineVariants, getEngineVariantBuildOutput } from '../test/engine-variants.ts';

const benchmarkDir = path.resolve(import.meta.dirname, '..');
const repositoryDir = path.resolve(benchmarkDir, '../..');
const buildCli = path.join(repositoryDir, 'tools/build/dist/cli.js');
const apiRoot = path.dirname(createRequire(import.meta.url).resolve('@pumpkin-plugins/pumpkin-api/package.json'));
const cacheDir = path.join(repositoryDir, '.cache');
const hermesCacheDir = process.env.STATIC_HERMES_CACHE_DIR ?? path.join(cacheDir, 'hermes');
const stackGuardSource = path.join(benchmarkDir, 'test/fixtures/stack-guard-plugin.ts');

fs.mkdirSync(cacheDir, { recursive: true });
const temporaryDir = fs.mkdtempSync(path.join(cacheDir, 'engine-comparison-build-'));

try {
    for (const variant of createEngineVariants()) {
        const packageDir = path.join(temporaryDir, variant.id);
        const sourceDir = path.join(packageDir, 'src');
        createBuildPackage(packageDir, `runtime-benchmark-${variant.id}`, {
            entry: 'src/plugin.ts',
            output: 'build/plugin.wasm',
            engine: variant.pluginEngine,
            wasi: [],
            ...(variant.staticHermesRuntime ? { staticHermesRuntime: variant.staticHermesRuntime } : {}),
            ...(variant.staticHermesGc ? { staticHermesGc: variant.staticHermesGc } : {})
        });
        fs.copyFileSync(path.join(benchmarkDir, 'src/benchmark-plugin.ts'), path.join(sourceDir, 'plugin.ts'));
        fs.copyFileSync(
            path.join(benchmarkDir, 'src/benchmark-workloads.ts'),
            path.join(sourceDir, 'benchmark-workloads.ts')
        );

        const wasmPath = buildPlugin(packageDir, variant.label, variant.parseTypeScript, false);
        publishComponent(wasmPath, getEngineVariantBuildOutput(benchmarkDir, variant.id));
    }

    for (const runtimeVariant of ['full', 'lean'] as const) {
        const id = `static-hermes-${runtimeVariant}-stack-guard`;
        const packageDir = path.join(temporaryDir, id);
        const sourceDir = path.join(packageDir, 'src');
        createBuildPackage(packageDir, `runtime-benchmark-${id}`, {
            entry: 'src/plugin.ts',
            output: 'build/plugin.wasm',
            engine: 'static-hermes',
            staticHermesRuntime: runtimeVariant,
            wasi: []
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
        `${JSON.stringify({ name, version: '0.0.0', pumpkinPlugin }, null, 2)}\n`
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
                    types: []
                },
                include: ['src/**/*.ts']
            },
            null,
            2
        )}\n`
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
            STATIC_HERMES_CACHE_DIR: hermesCacheDir
        },
        maxBuffer: 16 * 1024 * 1024
    });
    if (buildOutput.includes('-parse-ts') !== parseTypeScript) {
        throw new Error(`${label} build selected an unexpected parser mode`);
    }
    console.log(`${label} build:\n${buildOutput.trim()}`);
    return path.join(packageDir, 'build/plugin.wasm');
}

function publishComponent(source: string, target: string): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
}
