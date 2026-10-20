import * as fs from 'node:fs';
import * as path from 'node:path';
import { startPumpkin } from '@pumpkin-plugins/test-harness';
import { expect, it } from 'vitest';
import { type EngineResult, formatInteger, median, validateMatchingResults } from '../src/benchmark-results.ts';
import { formatConsoleReport, formatReport } from '../src/engine-comparison-report.ts';
import {
    createEngineComparisonMatrix,
    createEngineVariants,
    type EngineVariant,
    getEngineVariantBuildOutput,
} from '../src/engine-variants.ts';

const engineVariants = createEngineVariants();
const engineComparisonMatrix = createEngineComparisonMatrix();
const sizeBaselineEngineId = 'quickjs';
const requestedVariantId = process.env.ENGINE_COMPARISON_VARIANT;
const selectedVariant = engineVariants.find(({ id }) => id === requestedVariantId);
const selectedMatrixEntry = engineComparisonMatrix.find(({ variant }) => variant === requestedVariantId);
const selectedStackGuard = selectedMatrixEntry?.kind === 'stack-guard' ? selectedMatrixEntry : undefined;

const benchmarkDir = path.resolve(import.meta.dirname, '..');

if (requestedVariantId && !selectedVariant && !selectedStackGuard) {
    throw new Error(`Unknown engine comparison variant: ${requestedVariantId}`);
}

if (selectedStackGuard) {
    it(`checks the Static Hermes ${selectedStackGuard.runtime} stack guard`, async () => {
        const { runtime, variant: id } = selectedStackGuard;
        const wasmPath = getEngineVariantBuildOutput(benchmarkDir, id);
        expect(fs.existsSync(wasmPath), `${id} cached build is missing`).toBe(true);
        await verifyHermesStackGuard(wasmPath, runtime);
    }, 120_000);
} else {
    it(
        'compares configured engines across component sizes, behavior, and matching workloads',
        compareEngineConfigurations,
        Number.POSITIVE_INFINITY,
    );
}

async function compareEngineConfigurations(): Promise<void> {
    const results: EngineResult[] = [];

    for (const variant of selectedVariant ? [selectedVariant] : engineVariants) {
        const { id, label } = variant;
        const wasmPath = getEngineVariantBuildOutput(benchmarkDir, id);
        expect(fs.existsSync(wasmPath), `${label} cached build is missing; run compare-engines to build it`).toBe(true);
        const binarySizeBytes = fs.statSync(wasmPath).size;
        expect(binarySizeBytes, `${label} produced an empty component`).toBeGreaterThan(0);

        const server = await startPumpkin({
            name: `runtime-benchmark-${id}`,
            plugins: [wasmPath],
        });
        try {
            const readyLine = await server.waitForLog(
                /RUNTIME_BENCHMARK_READY|Failed to (?:load|initialize) plugin/,
                60_000,
            );
            expect(readyLine, `${label} did not register its benchmark command: ${readyLine}`).toContain(
                'RUNTIME_BENCHMARK_READY',
            );
            const commandOutputStart = server.lines.length;
            server.command('runtime-benchmark');
            const line = await server.waitForLog(
                /RUNTIME_BENCHMARK:|Failed to (?:load|initialize) plugin/,
                60_000,
                commandOutputStart,
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

    if (selectedVariant) {
        const result = results[0];
        if (!result) throw new Error(`${selectedVariant.label} did not produce benchmark results`);
        validateEngineFeatures(results, [selectedVariant]);
        validateApiBehavior(result);
        validateWorkloads(result);

        const resultPath = process.env.ENGINE_COMPARISON_RESULT_PATH;
        if (!resultPath) throw new Error('ENGINE_COMPARISON_RESULT_PATH is required for a matrix benchmark run');
        fs.mkdirSync(path.dirname(resultPath), { recursive: true });
        fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        process.stdout.write(`${selectedVariant.label} result saved to ${resultPath}\n`);
        return;
    }

    const baseline = requireResult(results, sizeBaselineEngineId);
    validateEngineFeatures(results, engineVariants);
    validateMatchingResults(results, baseline);
    validateApiBehavior(baseline);
    validateWorkloads(baseline);

    const hermesRuntimeProfiles = new Set(
        engineVariants
            .filter(
                ({ pluginEngine, staticHermesRuntime, staticHermesGc }) =>
                    pluginEngine === 'static-hermes' && staticHermesRuntime && staticHermesGc === 'hades',
            )
            .map(({ staticHermesRuntime }) => staticHermesRuntime),
    );
    for (const staticHermesRuntime of hermesRuntimeProfiles) {
        if (staticHermesRuntime) {
            const stackGuardId = `static-hermes-${staticHermesRuntime}-stack-guard`;
            const stackGuardPath = getEngineVariantBuildOutput(benchmarkDir, stackGuardId);
            expect(fs.existsSync(stackGuardPath), `${stackGuardId} cached build is missing`).toBe(true);
            await verifyHermesStackGuard(stackGuardPath, staticHermesRuntime);
        }
    }

    const report = formatReport(results, baseline.id);
    validateReport(report, results, baseline);
    process.stdout.write(`${formatConsoleReport(results, baseline.id)}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
}

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
            variant.runtimeSourceCompilation,
        );
        expect(result.unicodePropertyEscapes, `${variant.label} Unicode property escape capability`).toBe(
            variant.expectedUnicodePropertyEscapes(),
        );
    }
}

function validateApiBehavior(baseline: EngineResult): void {
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

/** Checks one engine's own workload output; validateMatchingResults compares engines with each other. */
function validateWorkloads(baseline: EngineResult): void {
    const workloadNames = baseline.workloads.map(({ name }) => name);
    expect(workloadNames.length).toBeGreaterThan(0);
    expect(new Set(workloadNames).size).toBe(workloadNames.length);
    expect(baseline.workloads.some(({ provenance }) => provenance === 'synthetic guest fixture')).toBe(true);
    expect(baseline.workloads.some(({ provenance }) => provenance === 'real Pumpkin API')).toBe(true);

    for (const workload of baseline.workloads) {
        expect(workload.operationsPerSample).toBeGreaterThan(0);
        expect(Number.isFinite(workload.checksum)).toBe(true);
        expect(workload.checksum, `${baseline.label} ${workload.name} correctness checks`).not.toBe(-1);
        expect(workload.samplesMs.length).toBeGreaterThan(0);
        expect(workload.samplesMs.every((sample) => Number.isFinite(sample) && sample >= 0)).toBe(true);
    }
}

function validateReport(report: string, results: EngineResult[], baseline: EngineResult): void {
    expect(report).toContain(baseline.label);
    for (const result of results) {
        expect(report).toContain(result.label);
        expect(report).toContain(`${formatInteger(result.binarySizeBytes)} bytes`);
    }

    for (const workload of baseline.workloads) {
        expect(report).toContain(workload.name);
        expect(report).toContain(workload.area);
        expect(report).toContain(formatInteger(workload.operationsPerSample));
        for (const result of results) {
            const resultWorkload = result.workloads.find(({ name }) => name === workload.name);
            if (!resultWorkload) throw new Error(`${result.label} is missing workload ${workload.name}`);
            expect(report).toContain(median(resultWorkload.samplesMs).toFixed(2));
        }
    }

    const averageSectionStart = report.indexOf('### Average performance across all benchmarks');
    expect(averageSectionStart).toBeGreaterThanOrEqual(0);
    const averageSection = report.slice(averageSectionStart);
    for (const result of results) {
        expect(averageSection).toContain(averageMedian(result.workloads).toFixed(2));
    }
}

function averageMedian(workloads: EngineResult['workloads']): number {
    return workloads.reduce((total, workload) => total + median(workload.samplesMs), 0) / workloads.length;
}

async function verifyHermesStackGuard(
    wasmPath: string,
    runtimeVariant: NonNullable<EngineVariant['staticHermesRuntime']>,
): Promise<void> {
    const server = await startPumpkin({
        name: `runtime-stack-guard-static-hermes-${runtimeVariant}`,
        plugins: [wasmPath],
    });
    try {
        const line = await server.waitForLog(/STACK_GUARD:|Failed to (?:load|initialize) plugin/, 60_000);
        expect(line, 'Static Hermes must turn a recursive stack overflow into a catchable JS RangeError').toContain(
            'STACK_GUARD:true',
        );
        expect(server.errors()).toEqual([]);
    } finally {
        await server.stop();
    }
}
