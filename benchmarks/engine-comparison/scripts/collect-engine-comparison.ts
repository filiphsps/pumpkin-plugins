import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BenchmarkWorkload } from '../src/benchmark-workloads.ts';
import { type EngineResult, formatReport } from '../test/engine-comparison-report.ts';
import { createEngineVariants } from '../test/engine-variants.ts';

const resultDirectory = process.env.ENGINE_COMPARISON_RESULT_DIR;
const reportDirectory = process.env.ENGINE_COMPARISON_REPORT_DIR;
if (!resultDirectory || !reportDirectory) {
    throw new Error('ENGINE_COMPARISON_RESULT_DIR and ENGINE_COMPARISON_REPORT_DIR are required');
}

const variants = createEngineVariants();
const results = variants.map((variant) => {
    const resultPath = path.join(resultDirectory, `${variant.id}.json`);
    if (!fs.existsSync(resultPath)) throw new Error(`Missing matrix result for ${variant.id}: ${resultPath}`);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as EngineResult;
    if (result.id !== variant.id || result.label !== variant.label) {
        throw new Error(`Matrix result ${resultPath} does not match ${variant.label}`);
    }
    if (result.binarySizeBytes <= 0) throw new Error(`${variant.label} produced an empty component`);
    return result;
});

validateMatchingResults(results);
const report = formatReport(results, 'quickjs');
fs.mkdirSync(reportDirectory, { recursive: true });
fs.writeFileSync(path.join(reportDirectory, 'engine-comparison-results.json'), `${JSON.stringify(results, null, 2)}\n`);
fs.writeFileSync(path.join(reportDirectory, 'report.md'), `${report}\n`);

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
    fs.appendFileSync(
        summaryPath,
        `${report}\n\n[Download the complete benchmark data and report](https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/artifacts)\n`,
    );
}

process.stdout.write(`Collected ${results.length} engine benchmark results into ${reportDirectory}\n`);

function validateMatchingResults(engines: EngineResult[]): void {
    const baseline = engines[0];
    if (!baseline) throw new Error('Engine comparison has no matrix results');
    const baselineWorkloads = indexWorkloads(baseline);

    for (const engine of engines.slice(1)) {
        if (!sameApiBehavior(engine, baseline)) {
            throw new Error(`${engine.label} API behavior differs from ${baseline.label}`);
        }

        const workloads = indexWorkloads(engine);
        if (workloads.size !== baselineWorkloads.size) {
            throw new Error(`${engine.label} does not report the same workloads as ${baseline.label}`);
        }
        for (const [name, expected] of baselineWorkloads) {
            const actual = workloads.get(name);
            if (!actual) throw new Error(`${engine.label} is missing workload ${name}`);
            if (
                actual.area !== expected.area ||
                actual.provenance !== expected.provenance ||
                actual.operationsPerSample !== expected.operationsPerSample ||
                actual.checksum !== expected.checksum
            ) {
                throw new Error(`${engine.label} workload ${name} does not match ${baseline.label}`);
            }
            if (
                actual.samplesMs.length !== expected.samplesMs.length ||
                actual.samplesMs.length === 0 ||
                actual.samplesMs.some((sample) => !Number.isFinite(sample) || sample < 0)
            ) {
                throw new Error(`${engine.label} workload ${name} has invalid timing samples`);
            }
        }
    }
}

function indexWorkloads(engine: EngineResult): Map<string, BenchmarkWorkload> {
    const indexed = new Map<string, BenchmarkWorkload>();
    for (const workload of engine.workloads) {
        if (indexed.has(workload.name)) throw new Error(`${engine.label} reports duplicate workload ${workload.name}`);
        if (workload.samplesMs.length === 0)
            throw new Error(`${engine.label} workload ${workload.name} has no samples`);
        indexed.set(workload.name, workload);
    }
    return indexed;
}

function sameApiBehavior(left: EngineResult, right: EngineResult): boolean {
    return Object.keys(right.apiBehavior).every(
        (key) =>
            left.apiBehavior[key as keyof EngineResult['apiBehavior']] ===
            right.apiBehavior[key as keyof EngineResult['apiBehavior']],
    );
}
