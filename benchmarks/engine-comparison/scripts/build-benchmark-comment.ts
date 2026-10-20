import * as fs from 'node:fs';
import { formatBenchmarkChangeSvgs } from '../src/benchmark-chart.ts';
import { formatBenchmarkComment } from '../src/benchmark-comment.ts';
import { compareBenchmarkResults } from '../src/benchmark-regression.ts';
import { API_BEHAVIOR_KEYS, type EngineResult } from '../src/benchmark-results.ts';
import type { BenchmarkWorkload } from '../src/benchmark-workloads.ts';

const headResults = readEngineResults(requiredEnvironment('ENGINE_COMPARISON_HEAD_RESULTS'));
const repository = requiredEnvironment('GITHUB_REPOSITORY');
const baselinePath = process.env.ENGINE_COMPARISON_BASELINE_RESULTS;
const baselineResults = baselinePath ? readEngineResults(baselinePath) : undefined;
const jitterThreshold = Number(process.env.BENCHMARK_JITTER_PERCENT ?? '10');
if (!Number.isFinite(jitterThreshold) || jitterThreshold < 0 || jitterThreshold > 100) {
    throw new Error('BENCHMARK_JITTER_PERCENT must be a finite percentage from 0 through 100');
}
const comparison = compareBenchmarkResults(headResults, baselineResults ?? [], jitterThreshold);
const currentSha = requiredEnvironment('CURRENT_SHA');
const baselineSha = baselineResults ? process.env.BASELINE_SHA : undefined;
const reportRunUrl = `${requiredEnvironment('GITHUB_SERVER_URL')}/${repository}/actions/runs/${requiredEnvironment('SOURCE_RUN_ID')}`;
const comment = formatBenchmarkComment({
    baselineSha,
    chartUrls:
        process.env.BENCHMARK_CHANGE_SVG_LIGHT_URL && process.env.BENCHMARK_CHANGE_SVG_DARK_URL
            ? {
                  light: process.env.BENCHMARK_CHANGE_SVG_LIGHT_URL,
                  dark: process.env.BENCHMARK_CHANGE_SVG_DARK_URL,
              }
            : undefined,
    comparison: baselineResults ? comparison : undefined,
    currentSha,
    noBaselineReason:
        process.env.NO_BASELINE_REASON ??
        'No successful default-branch benchmark is available at or before the PR base.',
    reportRunUrl,
});

const lightChartPath = process.env.BENCHMARK_CHANGE_SVG_LIGHT;
const darkChartPath = process.env.BENCHMARK_CHANGE_SVG_DARK;
if (lightChartPath || darkChartPath) {
    if (!lightChartPath || !darkChartPath) {
        throw new Error('Set both BENCHMARK_CHANGE_SVG_LIGHT and BENCHMARK_CHANGE_SVG_DARK');
    }
    const charts = formatBenchmarkChangeSvgs(comparison);
    fs.writeFileSync(lightChartPath, charts.light);
    fs.writeFileSync(darkChartPath, charts.dark);
    process.stdout.write(`Benchmark light and dark charts written to ${lightChartPath} and ${darkChartPath}\n`);
}

const commentPath = process.env.BENCHMARK_COMMENT_FILE;
if (commentPath) {
    fs.writeFileSync(commentPath, `${comment}\n`);
    process.stdout.write(`Benchmark comment written to ${commentPath}\n`);
}
if (!lightChartPath && !darkChartPath && !commentPath) {
    throw new Error('Set BENCHMARK_CHANGE_SVG_LIGHT, BENCHMARK_CHANGE_SVG_DARK, or BENCHMARK_COMMENT_FILE');
}

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath && commentPath) fs.appendFileSync(summaryPath, `${comment}\n`);

function readEngineResults(filePath: string): EngineResult[] {
    const fileSizeBytes = fs.statSync(filePath).size;
    if (fileSizeBytes > 5_000_000) throw new Error(`Benchmark result file exceeds 5 MB: ${filePath}`);
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 20) {
        throw new Error(`Benchmark results must contain between 1 and 20 engine entries: ${filePath}`);
    }
    return parsed.map((entry, index) => validateEngineResult(entry, `${filePath} engine ${index + 1}`));
}

function validateEngineResult(value: unknown, description: string): EngineResult {
    if (!isRecord(value)) throw new Error(`${description} is not an object`);
    if (
        !isDisplayString(value.id, 100) ||
        !isDisplayString(value.label, 100) ||
        !isFiniteNumber(value.binarySizeBytes) ||
        value.binarySizeBytes <= 0 ||
        value.binarySizeBytes > 100_000_000 ||
        typeof value.runtimeSourceCompilation !== 'boolean' ||
        typeof value.unicodePropertyEscapes !== 'boolean'
    ) {
        throw new Error(`${description} has invalid engine metadata`);
    }
    if (!isRecord(value.apiBehavior)) throw new Error(`${description} has invalid API behavior data`);
    for (const key of API_BEHAVIOR_KEYS) {
        if (!isFiniteNumber(value.apiBehavior[key]) || value.apiBehavior[key] < 0) {
            throw new Error(`${description} has invalid API behavior count ${key}`);
        }
    }
    const apiBehavior = value.apiBehavior as unknown as EngineResult['apiBehavior'];
    if (!Array.isArray(value.workloads) || value.workloads.length === 0 || value.workloads.length > 300) {
        throw new Error(`${description} has an invalid workload list`);
    }

    const workloads = value.workloads.map((workload, index) =>
        validateWorkload(workload, `${description} workload ${index + 1}`),
    );
    return {
        apiBehavior,
        binarySizeBytes: value.binarySizeBytes,
        id: value.id,
        label: value.label,
        runtimeSourceCompilation: value.runtimeSourceCompilation,
        unicodePropertyEscapes: value.unicodePropertyEscapes,
        workloads,
    };
}

function validateWorkload(value: unknown, description: string): BenchmarkWorkload {
    if (!isRecord(value)) throw new Error(`${description} is not an object`);
    if (
        !isDisplayString(value.name, 100) ||
        !isDisplayString(value.area, 200) ||
        !isFiniteNumber(value.operationsPerSample) ||
        value.operationsPerSample <= 0 ||
        value.operationsPerSample > 1_000_000_000_000 ||
        !isFiniteNumber(value.checksum) ||
        Math.abs(value.checksum) > 1_000_000_000_000_000 ||
        (value.provenance !== 'synthetic guest fixture' && value.provenance !== 'real Pumpkin API') ||
        !Array.isArray(value.samplesMs) ||
        value.samplesMs.length === 0 ||
        value.samplesMs.length > 100 ||
        value.samplesMs.some((sample) => !Number.isSafeInteger(sample) || sample < 0 || sample > 86_400_000)
    ) {
        throw new Error(`${description} has invalid metadata or timing samples`);
    }
    return {
        name: value.name,
        area: value.area,
        operationsPerSample: value.operationsPerSample,
        checksum: value.checksum,
        provenance: value.provenance,
        samplesMs: value.samplesMs,
    };
}

function requiredEnvironment(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDisplayString(value: unknown, maximumLength: number): value is string {
    return (
        typeof value === 'string' && value.length > 0 && value.length <= maximumLength && !hasControlCharacters(value)
    );
}

function hasControlCharacters(value: string): boolean {
    return [...value].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint < 0x20 || codePoint === 0x7f || codePoint === 0x2028 || codePoint === 0x2029;
    });
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}
