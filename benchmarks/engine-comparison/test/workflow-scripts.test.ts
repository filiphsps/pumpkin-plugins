import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import type { EngineResult } from '../src/benchmark-results.ts';
import { createEngineVariants } from '../src/engine-variants.ts';

const benchmarkDirectory = path.resolve(import.meta.dirname, '..');

it('writes matrix entries for every configured engine and runtime stack guard', () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-comparison-matrix-'));
    try {
        const outputPath = path.join(temporaryDirectory, 'github-output');
        const result = runScript('write-engine-comparison-matrix.ts', { GITHUB_OUTPUT: outputPath });
        expectScriptSucceeded(result);

        const outputLine = fs
            .readFileSync(outputPath, 'utf8')
            .split(/\r?\n/)
            .find((line) => line.startsWith('jobs='));
        expect(outputLine).toBeDefined();
        const matrix = JSON.parse(outputLine?.slice('jobs='.length) ?? '') as {
            include: { kind: 'benchmark' | 'stack-guard'; runtime?: string; variant: string }[];
        };
        const variants = createEngineVariants();
        const benchmarkJobs = matrix.include.filter(({ kind }) => kind === 'benchmark');
        const stackGuardJobs = matrix.include.filter(({ kind }) => kind === 'stack-guard');
        const runtimeProfiles = new Set(variants.flatMap(({ staticHermesRuntime }) => staticHermesRuntime ?? []));

        expect(benchmarkJobs).toHaveLength(variants.length);
        expect(new Set(benchmarkJobs.map(({ variant }) => variant))).toEqual(new Set(variants.map(({ id }) => id)));
        expect(stackGuardJobs).toHaveLength(runtimeProfiles.size);
        for (const runtime of runtimeProfiles) {
            expect(stackGuardJobs).toContainEqual({
                kind: 'stack-guard',
                runtime,
                variant: `static-hermes-${runtime}-stack-guard`,
            });
        }
    } finally {
        fs.rmSync(temporaryDirectory, { force: true, recursive: true });
    }
});

it('collects matching results and rejects an incomplete benchmark matrix', () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-comparison-collect-'));
    try {
        const resultDirectory = path.join(temporaryDirectory, 'results');
        const reportDirectory = path.join(temporaryDirectory, 'report');
        fs.mkdirSync(resultDirectory);
        const variants = createEngineVariants();
        const fixtureResults = variants.map((variant, index) => createEngineResult(variant.id, variant.label, index));
        for (const result of fixtureResults) {
            fs.writeFileSync(path.join(resultDirectory, `${result.id}.json`), JSON.stringify(result));
        }

        const result = runScript('collect-engine-comparison.ts', {
            ENGINE_COMPARISON_RESULT_DIR: resultDirectory,
            ENGINE_COMPARISON_REPORT_DIR: reportDirectory,
        });
        expectScriptSucceeded(result);

        const collected = JSON.parse(
            fs.readFileSync(path.join(reportDirectory, 'engine-comparison-results.json'), 'utf8'),
        ) as EngineResult[];
        const report = fs.readFileSync(path.join(reportDirectory, 'report.md'), 'utf8');
        expect(new Set(collected.map(({ id }) => id))).toEqual(new Set(variants.map(({ id }) => id)));
        expect(collected.every(({ workloads }) => workloads[0]?.name === 'shared-workload')).toBe(true);
        expect(collected.map(({ workloads }) => workloads[0]?.samplesMs[1])).toContain(12);
        expect(collected.map(({ workloads }) => workloads[0]?.samplesMs[1])).toContain(20);
        expect(report).toContain('shared-workload');
        expect(report).toContain('Synthetic fixture operation');
        expect(report).toContain('20.00');

        const missingVariant = variants.at(-1);
        if (!missingVariant) throw new Error('The engine benchmark configuration is empty');
        fs.rmSync(path.join(resultDirectory, `${missingVariant.id}.json`));
        const incompleteReportDirectory = path.join(temporaryDirectory, 'incomplete-report');
        const incomplete = runScript('collect-engine-comparison.ts', {
            ENGINE_COMPARISON_RESULT_DIR: resultDirectory,
            ENGINE_COMPARISON_REPORT_DIR: incompleteReportDirectory,
        });
        expect(incomplete.status).not.toBe(0);
        expect(fs.existsSync(path.join(incompleteReportDirectory, 'engine-comparison-results.json'))).toBe(false);
    } finally {
        fs.rmSync(temporaryDirectory, { force: true, recursive: true });
    }
});

it('writes a PR comment and SVG from current and baseline result artifacts', () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-comparison-comment-'));
    try {
        const headResultsPath = path.join(temporaryDirectory, 'head.json');
        const baselineResultsPath = path.join(temporaryDirectory, 'baseline.json');
        const commentPath = path.join(temporaryDirectory, 'comment.md');
        const lightChartPath = path.join(temporaryDirectory, 'changes-light.svg');
        const darkChartPath = path.join(temporaryDirectory, 'changes-dark.svg');
        fs.writeFileSync(headResultsPath, JSON.stringify([createSingleWorkloadEngine('quickjs', 125)]));
        fs.writeFileSync(baselineResultsPath, JSON.stringify([createSingleWorkloadEngine('quickjs', 100)]));
        const lightChartUrl =
            'https://raw.githubusercontent.com/example/repo/benchmark-charts/engine-comparison/456-light.svg';
        const darkChartUrl =
            'https://raw.githubusercontent.com/example/repo/benchmark-charts/engine-comparison/456-dark.svg';

        const result = runScript('build-benchmark-comment.ts', {
            ENGINE_COMPARISON_HEAD_RESULTS: headResultsPath,
            ENGINE_COMPARISON_BASELINE_RESULTS: baselineResultsPath,
            BENCHMARK_COMMENT_FILE: commentPath,
            BENCHMARK_CHANGE_SVG_LIGHT: lightChartPath,
            BENCHMARK_CHANGE_SVG_DARK: darkChartPath,
            BENCHMARK_CHANGE_SVG_LIGHT_URL: lightChartUrl,
            BENCHMARK_CHANGE_SVG_DARK_URL: darkChartUrl,
            BASELINE_SHA: '1234567890abcdef',
            CURRENT_SHA: 'abcdef1234567890',
            GITHUB_REPOSITORY: 'example/repo',
            GITHUB_SERVER_URL: 'https://github.com',
            SOURCE_RUN_ID: '456',
        });
        expectScriptSucceeded(result);

        const comment = fs.readFileSync(commentPath, 'utf8');
        const lightChart = fs.readFileSync(lightChartPath, 'utf8');
        const darkChart = fs.readFileSync(darkChartPath, 'utf8');
        expect(comment.split('\n')[0]).toMatch(/regression/i);
        expect(comment).toContain('shared-workload');
        expect(comment).toContain('https://github.com/example/repo/actions/runs/456');
        expect(comment).toContain('<picture>');
        expect(comment).toContain(`srcset="${darkChartUrl}"`);
        expect(comment).toContain(`srcset="${lightChartUrl}"`);
        expect(comment).toContain(`[Download light SVG](${lightChartUrl})`);
        expect(comment).toContain(`[Download dark SVG](${darkChartUrl})`);
        expect(comment).not.toContain('/actions/runs/456/artifacts');
        expect(lightChart).toContain('<svg');
        expect(lightChart).toContain('shared-workload');
        expect(lightChart).toContain('#FFFFFF');
        expect(darkChart).toContain('#0D1117');
    } finally {
        fs.rmSync(temporaryDirectory, { force: true, recursive: true });
    }
}, 15_000);

it('writes component-size charts without classifying timings when no baseline is available', () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-comparison-no-baseline-'));
    try {
        const headResultsPath = path.join(temporaryDirectory, 'head.json');
        const lightChartPath = path.join(temporaryDirectory, 'changes-light.svg');
        const darkChartPath = path.join(temporaryDirectory, 'changes-dark.svg');
        fs.writeFileSync(headResultsPath, JSON.stringify([createSingleWorkloadEngine('quickjs', 125)]));

        const result = runScript('build-benchmark-comment.ts', {
            ENGINE_COMPARISON_HEAD_RESULTS: headResultsPath,
            BENCHMARK_CHANGE_SVG_LIGHT: lightChartPath,
            BENCHMARK_CHANGE_SVG_DARK: darkChartPath,
            CURRENT_SHA: 'abcdef1234567890',
            GITHUB_REPOSITORY: 'example/repo',
            GITHUB_SERVER_URL: 'https://github.com',
            SOURCE_RUN_ID: '456',
        });
        expectScriptSucceeded(result);

        const lightChart = fs.readFileSync(lightChartPath, 'utf8');
        const darkChart = fs.readFileSync(darkChartPath, 'utf8');
        expect(lightChart).toContain('COMPONENT SIZE BY ENGINE');
        expect(lightChart).toContain('QuickJS reference size');
        expect(lightChart).toContain('No comparable workload timings in this run.');
        expect(darkChart).toContain('#0D1117');
    } finally {
        fs.rmSync(temporaryDirectory, { force: true, recursive: true });
    }
}, 15_000);

function createEngineResult(id: string, label: string, index: number): EngineResult {
    const variant = createEngineVariants().find((candidate) => candidate.id === id);
    if (!variant) throw new Error(`Unknown engine configuration: ${id}`);

    return {
        id,
        label,
        binarySizeBytes: 1_000 + index,
        apiBehavior: {
            eventRegistrations: 2,
            eventDispatches: 2,
            scheduledTasks: 1,
            scheduledCallbacks: 1,
            permissionRegistrations: 1,
            commandRegistrations: 1,
            commandDispatches: 1,
            serverQueries: 1,
            playersObserved: 0,
        },
        runtimeSourceCompilation: variant.runtimeSourceCompilation,
        unicodePropertyEscapes: variant.expectedUnicodePropertyEscapes(),
        workloads: [
            {
                name: 'shared-workload',
                area: 'Synthetic fixture operation',
                operationsPerSample: 4,
                checksum: 42,
                provenance: 'synthetic guest fixture',
                samplesMs: [10 + index, 12 + index, 14 + index],
            },
        ],
    };
}

function createSingleWorkloadEngine(id: string, timing: number): EngineResult {
    const result = createEngineResult(id, 'QuickJS', 0);
    const workload = result.workloads[0];
    if (!workload) throw new Error('The comment fixture has no benchmark workload');

    return {
        ...result,
        workloads: [{ ...workload, samplesMs: [timing, timing, timing] }],
    };
}

function runScript(scriptName: string, environment: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
    const scriptPath = path.join(benchmarkDirectory, 'scripts', scriptName);
    return spawnSync(process.execPath, [scriptPath], {
        cwd: benchmarkDirectory,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '', ...environment },
    });
}

function expectScriptSucceeded(result: SpawnSyncReturns<string>): void {
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
}
