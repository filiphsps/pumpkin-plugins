import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { startPumpkin } from '@pumpkin-plugins/test-harness';
import { expect, it } from 'vitest';
import { type EngineResult, formatConsoleReport, formatReport } from './engine-comparison-report.ts';

interface EngineVariant {
    id: string;
    label: string;
    pluginEngine: 'quickjs' | 'static-hermes';
    staticHermesRuntime?: 'full' | 'lean';
    runtimeSourceCompilation: boolean;
    expectedUnicodePropertyEscapes: () => boolean;
}

const engineVariants: EngineVariant[] = [
    {
        id: 'quickjs',
        label: 'QuickJS',
        pluginEngine: 'quickjs',
        runtimeSourceCompilation: true,
        expectedUnicodePropertyEscapes: () => true
    },
    {
        id: 'static-hermes-full',
        label: 'Static Hermes full',
        pluginEngine: 'static-hermes',
        staticHermesRuntime: 'full',
        runtimeSourceCompilation: true,
        expectedUnicodePropertyEscapes: () => process.env.STATIC_HERMES_ENABLE_UNICODE_REGEXP_PROPERTY_ESCAPES !== '0'
    },
    {
        id: 'static-hermes-lean',
        label: 'Static Hermes lean',
        pluginEngine: 'static-hermes',
        staticHermesRuntime: 'lean',
        runtimeSourceCompilation: false,
        expectedUnicodePropertyEscapes: () => process.env.STATIC_HERMES_ENABLE_UNICODE_REGEXP_PROPERTY_ESCAPES !== '0'
    }
];
const sizeBaselineEngineId = 'quickjs';

const runtimeDir = path.resolve(import.meta.dirname, '..');
const repositoryDir = path.resolve(runtimeDir, '../..');
const buildCli = path.join(repositoryDir, 'tools/build/bin/pumpkin-plugins-build.mjs');
const benchmarkEntry = path.join(runtimeDir, 'src/benchmark-plugin.ts');
const benchmarkWorkloads = path.join(runtimeDir, 'src/benchmark-workloads.ts');
const apiRoot = path.dirname(createRequire(import.meta.url).resolve('@pumpkinmc/pumpkin-api-ts/package.json'));
it('compares configured engines across component sizes, behavior, and matching workloads', async () => {
    const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-engine-comparison-'));
    const results: EngineResult[] = [];

    try {
        for (const variant of engineVariants) {
            const { id, label, pluginEngine, staticHermesRuntime } = variant;
            const packageDir = path.join(temporaryDir, id);
            const sourceDir = path.join(packageDir, 'src');
            const apiLink = path.join(packageDir, 'node_modules/@pumpkinmc/pumpkin-api-ts');
            fs.mkdirSync(sourceDir, { recursive: true });
            fs.mkdirSync(path.dirname(apiLink), { recursive: true });
            fs.copyFileSync(benchmarkEntry, path.join(sourceDir, 'plugin.ts'));
            fs.copyFileSync(benchmarkWorkloads, path.join(sourceDir, 'benchmark-workloads.ts'));
            fs.symlinkSync(apiRoot, apiLink, 'dir');
            fs.writeFileSync(
                path.join(packageDir, 'package.json'),
                `${JSON.stringify(
                    {
                        name: `runtime-benchmark-${id}`,
                        version: '0.0.0',
                        pumpkinPlugin: {
                            entry: 'src/plugin.ts',
                            output: 'build/plugin.wasm',
                            engine: pluginEngine,
                            wasi: [],
                            ...(pluginEngine === 'static-hermes' && staticHermesRuntime ? { staticHermesRuntime } : {})
                        }
                    },
                    null,
                    2
                )}\n`
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

            const buildOutput = execFileSync(process.execPath, [buildCli], {
                cwd: packageDir,
                encoding: 'utf8',
                env: { ...process.env, PUMPKIN_API_DIR: apiRoot, PUMPKIN_DEV_MODE: '0' },
                maxBuffer: 16 * 1024 * 1024
            });
            console.log(`${label} build:\n${buildOutput.trim()}`);

            const wasmPath = path.join(packageDir, 'build/plugin.wasm');
            const binarySizeBytes = fs.statSync(wasmPath).size;
            expect(binarySizeBytes, `${label} produced an empty component`).toBeGreaterThan(0);

            const server = await startPumpkin({
                name: `runtime-benchmark-${id}`,
                plugins: [wasmPath]
            });
            try {
                const readyLine = await server.waitForLog(
                    /RUNTIME_BENCHMARK_READY|Failed to (?:load|initialize) plugin/,
                    60_000
                );
                expect(readyLine, `${label} did not register its benchmark command: ${readyLine}`).toContain(
                    'RUNTIME_BENCHMARK_READY'
                );
                const commandOutputStart = server.lines.length;
                server.command('runtime-benchmark');
                const line = await server.waitForLog(
                    /RUNTIME_BENCHMARK:|Failed to (?:load|initialize) plugin/,
                    60_000,
                    commandOutputStart
                );
                const payload = line.match(/RUNTIME_BENCHMARK:(\{.*\})/);
                expect(payload, `${label} did not emit benchmark results: ${line}`).not.toBeNull();
                results.push({ id, label, binarySizeBytes, ...JSON.parse(payload?.[1] ?? '') });
                console.log(`${label} results: ${JSON.stringify(results.at(-1))}`);
                expect(server.errors(), `${label} logged runtime errors:\n${server.errors().join('\n')}`).toEqual([]);
            } finally {
                await server.stop();
            }
        }

        const baseline = requireResult(results, sizeBaselineEngineId);
        validateEngineFeatures(results, engineVariants);
        validateApiBehavior(results, baseline);
        validateWorkloads(results, baseline);

        const hermesVariants = engineVariants.filter(
            ({ pluginEngine, staticHermesRuntime }) => pluginEngine === 'static-hermes' && staticHermesRuntime
        );
        for (const { staticHermesRuntime } of hermesVariants) {
            if (staticHermesRuntime) await verifyHermesStackGuard(temporaryDir, apiRoot, buildCli, staticHermesRuntime);
        }

        const report = formatReport(results, baseline.id);
        validateReport(report, results, baseline);
        process.stdout.write(`${formatConsoleReport(results, baseline.id)}\n`);
        if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
    } finally {
        fs.rmSync(temporaryDir, { recursive: true, force: true });
    }
}, 900_000);

function requireResult(results: EngineResult[], id: string): EngineResult {
    const result = results.find((candidate) => candidate.id === id);
    if (!result) throw new Error(`Benchmark engine result not found: ${id}`);
    return result;
}

function validateEngineFeatures(results: EngineResult[], variants: EngineVariant[]): void {
    expect(results.map(({ id }) => id).sort()).toEqual(variants.map(({ id }) => id).sort());
    for (const variant of variants) {
        const result = requireResult(results, variant.id);
        expect(result.runtimeSourceCompilation, `${variant.label} runtime compilation capability`).toBe(
            variant.runtimeSourceCompilation
        );
        expect(result.unicodePropertyEscapes, `${variant.label} Unicode property escape capability`).toBe(
            variant.expectedUnicodePropertyEscapes()
        );
    }
}

function validateApiBehavior(results: EngineResult[], baseline: EngineResult): void {
    for (const result of results) {
        expect(result.apiBehavior, `${result.label} API behavior differs from ${baseline.label}`).toEqual(
            baseline.apiBehavior
        );
    }

    const behavior = baseline.apiBehavior;
    expect(behavior.eventRegistrations).toBeGreaterThan(0);
    expect(behavior.eventDispatches).toBeGreaterThanOrEqual(behavior.eventRegistrations);
    expect(behavior.scheduledTasks).toBeGreaterThan(0);
    expect(behavior.scheduledCallbacks).toBeGreaterThan(0);
    expect(behavior.permissionRegistrations).toBeGreaterThan(0);
    expect(behavior.commandRegistrations).toBeGreaterThan(0);
    expect(behavior.commandDispatches).toBeGreaterThan(0);
    expect(behavior.serverQueries).toBeGreaterThan(0);
    expect(behavior.playersObserved).toBe(0);
}

function validateWorkloads(results: EngineResult[], baseline: EngineResult): void {
    const workloadNames = baseline.workloads.map(({ name }) => name);
    expect(workloadNames.length).toBeGreaterThan(0);
    expect(new Set(workloadNames).size).toBe(workloadNames.length);
    expect(baseline.workloads.some(({ provenance }) => provenance === 'synthetic guest fixture')).toBe(true);
    expect(baseline.workloads.some(({ provenance }) => provenance === 'real Pumpkin API')).toBe(true);

    for (const result of results) {
        const resultNames = result.workloads.map(({ name }) => name);
        expect(resultNames, `${result.label} workload count`).toHaveLength(workloadNames.length);
        expect([...resultNames].sort(), `${result.label} workload names`).toEqual([...workloadNames].sort());

        for (const expected of baseline.workloads) {
            const workload = result.workloads.find(({ name }) => name === expected.name);
            if (!workload) throw new Error(`${result.label} is missing workload ${expected.name}`);
            expect(workload.area).toBe(expected.area);
            expect(workload.provenance).toBe(expected.provenance);
            expect(workload.operationsPerSample).toBeGreaterThan(0);
            expect(workload.operationsPerSample).toBe(expected.operationsPerSample);
            expect(Number.isFinite(workload.checksum)).toBe(true);
            expect(workload.checksum, `${result.label} ${workload.name} checksum`).toBe(expected.checksum);
            expect(workload.samplesMs.length).toBeGreaterThan(0);
            expect(workload.samplesMs.length).toBe(expected.samplesMs.length);
            expect(workload.samplesMs.every((sample) => Number.isFinite(sample) && sample >= 0)).toBe(true);
        }
    }
}

function validateReport(report: string, results: EngineResult[], baseline: EngineResult): void {
    expect(report).toContain(`| Engine | Production component size | Difference from ${baseline.label} |`);
    for (const result of results) {
        const difference =
            result.id === baseline.id
                ? 'baseline'
                : expectedSizeDifference(result.binarySizeBytes, baseline.binarySizeBytes);
        expect(report).toContain(
            `| ${result.label} | ${result.binarySizeBytes.toLocaleString()} bytes | ${difference} |`
        );
    }

    const ratioLabels = results.filter(({ id }) => id !== baseline.id).map(({ label }) => `${baseline.label}/${label}`);
    const performanceColumns = results.map(({ label }) => `${label} median (min–max)`);
    expect(report).toContain(
        `| Benchmark type | Scope / workload | Inputs per sample | ${performanceColumns.join(' | ')} | ${ratioLabels.join(' | ')} |`
    );

    const workloadPrefixes = baseline.workloads.map(
        ({ name, area, provenance }) =>
            `| ${provenance === 'real Pumpkin API' ? 'real' : 'synthetic'} | ${area} / ${name} |`
    );
    for (const prefix of workloadPrefixes) expect(report).toContain(prefix);
    const reportWorkloadRows = report
        .split('\n')
        .filter((line) => line.startsWith('| synthetic |') || line.startsWith('| real |'));
    expect(reportWorkloadRows).toHaveLength(baseline.workloads.length);

    const averageCells = results.map((result) => averageMedian(result.workloads).toFixed(2));
    const averageRow = `| Average benchmark median (ms) | ${averageCells.join(' | ')} |`;
    expect(report.trimEnd().endsWith(averageRow)).toBe(true);
}

function expectedSizeDifference(sizeBytes: number, baselineBytes: number): string {
    const differenceBytes = sizeBytes - baselineBytes;
    const differencePercent = (100 * differenceBytes) / baselineBytes;
    const bytes = `${differenceBytes > 0 ? '+' : ''}${differenceBytes.toLocaleString()}`;
    const percent = `${differencePercent > 0 ? '+' : ''}${differencePercent.toFixed(2)}`;
    return `${bytes} bytes (${percent}%)`;
}

function averageMedian(workloads: EngineResult['workloads']): number {
    return workloads.reduce((total, workload) => total + median(workload.samplesMs), 0) / workloads.length;
}

async function verifyHermesStackGuard(
    temporaryDir: string,
    apiRoot: string,
    buildCli: string,
    runtimeVariant: 'full' | 'lean'
): Promise<void> {
    const packageDir = path.join(temporaryDir, `static-hermes-${runtimeVariant}-stack-guard`);
    const sourceDir = path.join(packageDir, 'src');
    const apiLink = path.join(packageDir, 'node_modules/@pumpkinmc/pumpkin-api-ts');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(path.dirname(apiLink), { recursive: true });
    fs.symlinkSync(apiRoot, apiLink, 'dir');
    fs.writeFileSync(
        path.join(packageDir, 'package.json'),
        `${JSON.stringify(
            {
                name: `runtime-stack-guard-static-hermes-${runtimeVariant}`,
                version: '0.0.0',
                pumpkinPlugin: {
                    entry: 'src/plugin.ts',
                    output: 'build/plugin.wasm',
                    engine: 'static-hermes',
                    staticHermesRuntime: runtimeVariant,
                    wasi: []
                }
            },
            null,
            2
        )}\n`
    );
    fs.writeFileSync(
        path.join(sourceDir, 'plugin.ts'),
        `import type { Context } from 'pumpkin:plugin/context@0.1.0';
import * as logging from 'pumpkin:plugin/logging@0.1.0';
import type { PluginMetadata } from 'pumpkin:plugin/metadata@0.1.0';
import { Plugin, registerPlugin } from '@pumpkinmc/pumpkin-api-ts';
export * from '@pumpkinmc/pumpkin-api-ts';
class StackGuardPlugin extends Plugin {
  metadata(): PluginMetadata { return { name: 'StackGuard', version: '0.0.0', authors: [], description: '', dependencies: [], permissions: [] }; }
  onLoad(context: Context): void { super.onLoad(context); logging.log('info', \`STACK_GUARD:\${catchesStackOverflow()}\`); }
}
function catchesStackOverflow(): boolean {
  function recurse(): number { return recurse() + 1; }
  try { recurse(); return false; }
  catch (error) { return error instanceof RangeError && error.message.includes('Maximum call stack size exceeded'); }
}
registerPlugin(new StackGuardPlugin());
`
    );

    execFileSync(process.execPath, [buildCli], {
        cwd: packageDir,
        encoding: 'utf8',
        env: { ...process.env, PUMPKIN_API_DIR: apiRoot, PUMPKIN_DEV_MODE: '0' },
        maxBuffer: 16 * 1024 * 1024
    });

    const server = await startPumpkin({
        name: `runtime-stack-guard-static-hermes-${runtimeVariant}`,
        plugins: [path.join(packageDir, 'build/plugin.wasm')]
    });
    try {
        const line = await server.waitForLog(/STACK_GUARD:|Failed to (?:load|initialize) plugin/, 60_000);
        expect(line, 'Static Hermes must turn a recursive stack overflow into a catchable JS RangeError').toContain(
            'STACK_GUARD:true'
        );
        expect(server.errors()).toEqual([]);
    } finally {
        await server.stop();
    }
}

function median(samples: number[]): number {
    const ordered = [...samples].sort((left, right) => left - right);
    return ordered[Math.floor(ordered.length / 2)];
}
