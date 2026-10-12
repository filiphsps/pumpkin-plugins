import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { startPumpkin } from '@pumpkin-plugins/test-harness';
import { expect, it } from 'vitest';

interface BenchmarkWorkload {
    name: string;
    area: string;
    operationsPerSample: number;
    samplesMs: number[];
    checksum: number;
}

interface EngineResult {
    binarySizeBytes: number;
    apiBehavior: {
        eventRegistrations: number;
        eventDispatches: number;
        scheduledTasks: number;
        scheduledCallbacks: number;
        permissionRegistrations: number;
        commandRegistrations: number;
        commandDispatches: number;
        serverQueries: number;
        playersObserved: number;
    };
    runtimeSourceCompilation: boolean;
    unicodePropertyEscapes: boolean;
    workloads: BenchmarkWorkload[];
}

const runtimeDir = path.resolve(import.meta.dirname, '..');
const repositoryDir = path.resolve(runtimeDir, '../..');
const buildCli = path.join(repositoryDir, 'tools/build/bin/pumpkin-plugins-build.mjs');
const benchmarkEntry = path.join(runtimeDir, 'src/benchmark-plugin.ts');
const benchmarkWorkloads = path.join(runtimeDir, 'src/benchmark-workloads.ts');
const apiRoot = path.dirname(createRequire(import.meta.url).resolve('@pumpkinmc/pumpkin-api-ts/package.json'));
const expectedWorkloads = [
    'numeric',
    'objects',
    'strings',
    'config-validation',
    'command-routing',
    'permission-resolution',
    'player-directory',
    'event-cache',
    'chat-formatting',
    'scoreboard-rendering',
    'region-protection',
    'world-edit-plan',
    'economy-transfers',
    'inventory-stacking',
    'cooldown-rate-limit',
    'tick-scheduler',
    'audit-history',
    'player-state-json',
    'custom-payload',
    'pumpkin-api'
];
const samplesPerWorkload = 5;

it('compares QuickJS, full Hermes, and lean Hermes sizes, behavior, and guest workloads', async () => {
    const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-engine-comparison-'));
    const results: Record<string, EngineResult> = {};

    try {
        for (const engine of ['quickjs', 'static-hermes', 'static-hermes-lean']) {
            const pluginEngine = engine === 'quickjs' ? 'quickjs' : 'static-hermes';
            const staticHermesRuntime = engine === 'static-hermes-lean' ? 'lean' : 'full';
            const packageDir = path.join(temporaryDir, engine);
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
                        name: `runtime-benchmark-${engine}`,
                        version: '0.0.0',
                        pumpkinPlugin: {
                            entry: 'src/plugin.ts',
                            output: 'build/plugin.wasm',
                            engine: pluginEngine,
                            wasi: [],
                            ...(pluginEngine === 'static-hermes' ? { staticHermesRuntime } : {})
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
            console.log(`${engine} build:\n${buildOutput.trim()}`);

            const wasmPath = path.join(packageDir, 'build/plugin.wasm');
            const binarySizeBytes = fs.statSync(wasmPath).size;
            expect(binarySizeBytes, `${engine} produced an empty component`).toBeGreaterThan(0);

            const server = await startPumpkin({
                name: `runtime-benchmark-${engine}`,
                plugins: [wasmPath]
            });
            try {
                const readyLine = await server.waitForLog(
                    /RUNTIME_BENCHMARK_READY|Failed to (?:load|initialize) plugin/,
                    60_000
                );
                expect(readyLine, `${engine} did not register its benchmark command: ${readyLine}`).toContain(
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
                expect(payload, `${engine} did not emit benchmark results: ${line}`).not.toBeNull();
                results[engine] = { binarySizeBytes, ...JSON.parse(payload?.[1] ?? '') };
                console.log(`${engine} results: ${JSON.stringify(results[engine])}`);
                expect(server.errors(), `${engine} logged runtime errors:\n${server.errors().join('\n')}`).toEqual([]);
            } finally {
                await server.stop();
            }
        }

        const quickjs = results.quickjs;
        const hermes = results['static-hermes'];
        const leanHermes = results['static-hermes-lean'];
        expect(quickjs.unicodePropertyEscapes).toBe(true);
        expect(hermes.unicodePropertyEscapes).toBe(
            process.env.STATIC_HERMES_ENABLE_UNICODE_REGEXP_PROPERTY_ESCAPES !== '0'
        );
        expect(leanHermes.unicodePropertyEscapes).toBe(hermes.unicodePropertyEscapes);
        expect(quickjs.runtimeSourceCompilation).toBe(true);
        expect(hermes.runtimeSourceCompilation).toBe(true);
        expect(leanHermes.runtimeSourceCompilation).toBe(false);
        for (const result of [quickjs, hermes, leanHermes]) {
            expect(result.workloads.map(({ name }) => name)).toEqual(expectedWorkloads);
            expect(result.apiBehavior.eventRegistrations).toBe(3);
            expect(result.apiBehavior.eventDispatches).toBeGreaterThanOrEqual(3);
            expect(result.apiBehavior.scheduledTasks).toBe(1);
            expect(result.apiBehavior.scheduledCallbacks).toBe(1);
            expect(result.apiBehavior.permissionRegistrations).toBe(1);
            expect(result.apiBehavior.commandRegistrations).toBe(1);
            expect(result.apiBehavior.commandDispatches).toBe(1);
            expect(result.apiBehavior.serverQueries).toBe(600);
            expect(result.apiBehavior.playersObserved).toBe(0);
        }

        for (let index = 0; index < expectedWorkloads.length; index++) {
            const quickjsWorkload = quickjs.workloads[index];
            const hermesWorkload = hermes.workloads[index];
            const leanWorkload = leanHermes.workloads[index];
            expect(quickjsWorkload.area).toBe(hermesWorkload.area);
            expect(quickjsWorkload.area).toBe(leanWorkload.area);
            expect(quickjsWorkload.operationsPerSample).toBeGreaterThan(0);
            expect(quickjsWorkload.operationsPerSample).toBe(hermesWorkload.operationsPerSample);
            expect(quickjsWorkload.operationsPerSample).toBe(leanWorkload.operationsPerSample);
            expect(Number.isFinite(quickjsWorkload.checksum)).toBe(true);
            expect(Number.isFinite(hermesWorkload.checksum)).toBe(true);
            expect(Number.isFinite(leanWorkload.checksum)).toBe(true);
            expect(quickjsWorkload.checksum, `${quickjsWorkload.name} result differs`).toBe(hermesWorkload.checksum);
            expect(quickjsWorkload.checksum, `${quickjsWorkload.name} result differs in lean Hermes`).toBe(
                leanWorkload.checksum
            );
            expect(quickjsWorkload.samplesMs).toHaveLength(samplesPerWorkload);
            expect(hermesWorkload.samplesMs).toHaveLength(samplesPerWorkload);
            expect(leanWorkload.samplesMs).toHaveLength(samplesPerWorkload);
            expect(quickjsWorkload.samplesMs.every((sample) => Number.isFinite(sample) && sample >= 0)).toBe(true);
            expect(hermesWorkload.samplesMs.every((sample) => Number.isFinite(sample) && sample >= 0)).toBe(true);
            expect(leanWorkload.samplesMs.every((sample) => Number.isFinite(sample) && sample >= 0)).toBe(true);
        }

        await verifyHermesStackGuard(temporaryDir, apiRoot, buildCli, 'full');
        await verifyHermesStackGuard(temporaryDir, apiRoot, buildCli, 'lean');

        const report = formatReport(quickjs, hermes, leanHermes);
        process.stdout.write(`${report}\n`);
        if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
    } finally {
        fs.rmSync(temporaryDir, { recursive: true, force: true });
    }
}, 900_000);

function formatReport(quickjs: EngineResult, hermes: EngineResult, leanHermes: EngineResult): string {
    const savedBytes = hermes.binarySizeBytes - leanHermes.binarySizeBytes;
    const savedPercent = (100 * savedBytes) / hermes.binarySizeBytes;
    const lines = [
        '### QuickJS and Static Hermes comparison',
        '',
        '| Engine | Production component size | Difference from full Hermes |',
        '| --- | ---: | ---: |',
        `| QuickJS | ${quickjs.binarySizeBytes.toLocaleString()} bytes | n/a |`,
        `| Static Hermes full | ${hermes.binarySizeBytes.toLocaleString()} bytes | baseline |`,
        `| Static Hermes lean | ${leanHermes.binarySizeBytes.toLocaleString()} bytes | -${savedBytes.toLocaleString()} bytes (${savedPercent.toFixed(2)}% smaller) |`,
        '',
        '| Plugin area / workload | Inputs per sample | QuickJS median | Hermes full median | Hermes lean median | QuickJS/full | QuickJS/lean |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: |'
    ];

    for (let index = 0; index < expectedWorkloads.length; index++) {
        const workload = quickjs.workloads[index];
        const quickjsMedian = median(quickjs.workloads[index].samplesMs);
        const hermesMedian = median(hermes.workloads[index].samplesMs);
        const leanMedian = median(leanHermes.workloads[index].samplesMs);
        const fullRatio = hermesMedian === 0 ? 'n/a' : `${(quickjsMedian / hermesMedian).toFixed(2)}x`;
        const leanRatio = leanMedian === 0 ? 'n/a' : `${(quickjsMedian / leanMedian).toFixed(2)}x`;
        lines.push(
            `| ${workload.area} / ${workload.name} | ${workload.operationsPerSample.toLocaleString()} | ${quickjsMedian.toFixed(2)} ms | ${hermesMedian.toFixed(2)} ms | ${leanMedian.toFixed(2)} ms | ${fullRatio} | ${leanRatio} |`
        );
    }

    lines.push(
        '',
        'Each workload uses five timed samples after one warm-up. Inputs per sample describe the guest-side fixture or requests; size and timing have no pass thresholds.',
        `Real Pumpkin calls per engine: ${quickjs.apiBehavior.eventRegistrations} tick-event listener registrations and ${quickjs.apiBehavior.eventDispatches} handler dispatches, 1 delayed task and callback, 1 permission registration, 1 command registration and dispatch, and ${quickjs.apiBehavior.serverQueries} getAllPlayers calls. The comparison server has no connected players; player workflows use deterministic guest-side fixtures.`,
        'Lean Hermes omits runtime source compilation, so `eval` and `Function(string)` are unavailable.'
    );
    return lines.join('\n');
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
