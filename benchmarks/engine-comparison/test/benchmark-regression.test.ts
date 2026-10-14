import { expect, it } from 'vitest';
import type { BenchmarkWorkload } from '../src/benchmark-workloads.ts';
import { compareBenchmarkResults, formatBenchmarkChangeSvg, formatBenchmarkComment } from './benchmark-regression.ts';
import type { EngineResult } from './engine-comparison-report.ts';

it('flags workload changes only when they exceed the jitter threshold', () => {
    const baseline = [engine('quickjs', [workload('stable', [100]), workload('slower', [100])])];
    const current = [engine('quickjs', [workload('stable', [110]), workload('slower', [111])])];
    const comparison = compareBenchmarkResults(current, baseline, 10);

    expect(comparison.status).toBe('warning');
    expect(comparison.regressions.map(({ workload: name }) => name)).toEqual(['slower']);
    expect(comparison.changes.find(({ workload: name }) => name === 'stable')?.status).toBe('within-jitter');
});

it('celebrates meaningful improvements and ignores zero-millisecond baselines', () => {
    const baseline = [engine('quickjs', [workload('faster', [100]), workload('unresolved', [0])])];
    const current = [engine('quickjs', [workload('faster', [85]), workload('unresolved', [5])])];
    const comparison = compareBenchmarkResults(current, baseline, 10);

    expect(comparison.status).toBe('celebration');
    expect(comparison.improvements.map(({ workload: name }) => name)).toEqual(['faster']);
    expect(comparison.skippedWorkloads).toHaveLength(1);
    expect(comparison.skippedWorkloads[0]).toContain('quickjs/unresolved');
});

it('shows warning, celebration, and regular outcomes in the PR comment', () => {
    const outcomes = [
        { currentMs: 125, heading: /regression/i, workload: 'slower' },
        { currentMs: 75, heading: /improvement/i, workload: 'faster' },
        { currentMs: 105, heading: /benchmark results/i },
    ];

    for (const outcome of outcomes) {
        const workloadName = outcome.workload ?? 'unchanged';
        const comparison = compareBenchmarkResults(
            [engine('quickjs', [workload(workloadName, [outcome.currentMs])])],
            [engine('quickjs', [workload(workloadName, [100])])],
        );
        const comment = formatBenchmarkComment({
            comparison,
            baselineSha: '1234567890abcdef',
            currentSha: 'abcdef1234567890',
            reportRunUrl: 'https://github.com/example/repo/actions/runs/123',
        });

        expect(comment.split('\n')[0]).toMatch(outcome.heading);
        if (outcome.workload) {
            expect(comment).toContain(outcome.workload);
        } else {
            expect(comment).toMatch(/no workload changed beyond.*jitter threshold/i);
        }
    }
});

it('renders a labeled SVG chart for the largest changes', async () => {
    const comparison = compareBenchmarkResults(
        [
            engine('quickjs', [
                workload('slower', [125]),
                workload('faster', [75]),
                workload('<script>alert(1)</script>', [102]),
            ]),
        ],
        [
            engine('quickjs', [
                workload('slower', [100]),
                workload('faster', [100]),
                workload('<script>alert(1)</script>', [100]),
            ]),
        ],
    );

    const svg = await formatBenchmarkChangeSvg(comparison);

    expect(svg).toContain('<svg');
    expect(svg).toContain('Benchmark timing changes');
    expect(svg).toContain('slower · quickjs');
    expect(svg).toContain('faster · quickjs');
    expect(svg).toContain('±10%');
    expect(svg).not.toContain('<script>');
});

it('escapes benchmark labels in the repeatable PR comment', () => {
    const comment = formatBenchmarkComment({
        comparison: compareBenchmarkResults(
            [engine('quickjs', [workload('@reviewer <script>', [80])])],
            [engine('quickjs', [workload('@reviewer <script>', [100])])],
            10,
        ),
        baselineSha: '1234567890abcdef',
        currentSha: 'abcdef1234567890',
        reportRunUrl: 'https://github.com/example/repo/actions/runs/123',
    });

    expect(comment.split('\n')[0]).toMatch(/improvement/i);
    expect(comment).toContain('@\u200breviewer &lt;script&gt;');
    expect(comment).toContain('https://github.com/example/repo/actions/runs/123');
    expect(comment).not.toContain('<script>');
});

it('links and embeds the published chart even without a baseline', () => {
    const chartUrl = 'https://raw.githubusercontent.com/example/repo/benchmark-reports/charts/123/1/chart.svg';
    const comment = formatBenchmarkComment({
        currentSha: 'abcdef1234567890',
        reportRunUrl: 'https://github.com/example/repo/actions/runs/123',
        chartUrl,
    });

    expect(comment).toContain(`[Download the SVG comparison chart](${chartUrl})`);
    expect(comment).toContain(`![Benchmark timing changes](${chartUrl})`);
    expect(comment).toContain('No matching baseline');
});

function engine(id: string, workloads: BenchmarkWorkload[]): EngineResult {
    return {
        apiBehavior: {
            eventRegistrations: 1,
            eventDispatches: 1,
            scheduledTasks: 1,
            scheduledCallbacks: 1,
            permissionRegistrations: 1,
            commandRegistrations: 1,
            commandDispatches: 1,
            serverQueries: 1,
            playersObserved: 0,
        },
        binarySizeBytes: 1_000,
        id,
        label: id,
        runtimeSourceCompilation: true,
        unicodePropertyEscapes: true,
        workloads,
    };
}

function workload(name: string, samplesMs: number[]): BenchmarkWorkload {
    return {
        area: name,
        checksum: 0,
        name,
        operationsPerSample: 1,
        provenance: 'synthetic guest fixture',
        samplesMs,
    };
}
