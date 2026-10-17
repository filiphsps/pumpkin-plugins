import { expect, it } from 'vitest';
import type { BenchmarkWorkload } from '../src/benchmark-workloads.ts';
import {
    compareBenchmarkResults,
    formatBenchmarkChangeSvg,
    formatBenchmarkChangeSvgs,
    formatBenchmarkComment,
} from './benchmark-regression.ts';
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

it('embeds the SVG chart and links directly to it from the PR comment', () => {
    const chartUrl = 'https://raw.githubusercontent.com/example/repo/benchmark-charts/engine-comparison/123.svg';
    const comparison = compareBenchmarkResults(
        [engine('quickjs', [workload('slower', [125])])],
        [engine('quickjs', [workload('slower', [100])])],
    );
    const comment = formatBenchmarkComment({
        chartUrl,
        comparison,
        baselineSha: '1234567890abcdef',
        currentSha: 'abcdef1234567890',
        reportRunUrl: 'https://github.com/example/repo/actions/runs/123',
    });

    expect(comment).toContain(`![Benchmark timing changes](${chartUrl})`);
    expect(comment).toContain(`[Download the SVG comparison chart](${chartUrl})`);
    expect(comment).not.toContain('/actions/runs/123/artifacts');
});

it('selects the light and dark SVG variants by GitHub color scheme', () => {
    const lightUrl = 'https://example.com/benchmark-light.svg';
    const darkUrl = 'https://example.com/benchmark-dark.svg';
    const comment = formatBenchmarkComment({
        chartUrls: { dark: darkUrl, light: lightUrl },
        comparison: compareBenchmarkResults(
            [engine('quickjs', [workload('slower', [125])])],
            [engine('quickjs', [workload('slower', [100])])],
        ),
        baselineSha: '1234567890abcdef',
        currentSha: 'abcdef1234567890',
        reportRunUrl: 'https://github.com/example/repo/actions/runs/123',
    });

    expect(comment).toContain(`media="(prefers-color-scheme: dark)" type="image/svg+xml" srcset="${darkUrl}"`);
    expect(comment).toContain(`media="(prefers-color-scheme: light)" type="image/svg+xml" srcset="${lightUrl}"`);
    expect(comment).toContain(`[Download light SVG](${lightUrl})`);
    expect(comment).toContain(`[Download dark SVG](${darkUrl})`);
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
    expect(svg).toContain('Runtime benchmark changes');
    expect(svg).toContain('slower · quickjs');
    expect(svg).toContain('faster · quickjs');
    expect(svg).toContain('±10%');
    expect(svg).not.toContain('<script>');
});

it('renders light and dark SVGs with full context and caps each timing direction at twelve rows', async () => {
    const baselineWorkloads = [
        ...Array.from({ length: 13 }, (_, index) => workload(`slower-${index}`, [100])),
        ...Array.from({ length: 14 }, (_, index) => workload(`faster-${index}`, [100])),
        workload('stable', [100]),
    ];
    const currentWorkloads = [
        ...Array.from({ length: 13 }, (_, index) => workload(`slower-${index}`, [130 + index])),
        ...Array.from({ length: 14 }, (_, index) => workload(`faster-${index}`, [60 + index])),
        workload('stable', [105]),
    ];
    const comparison = compareBenchmarkResults(
        [engine('quickjs', currentWorkloads)],
        [engine('quickjs', baselineWorkloads)],
    );

    const charts = await formatBenchmarkChangeSvgs(comparison);

    expect(charts.light).toContain('fill="#FFFFFF"');
    expect(charts.dark).toContain('fill="#0D1117"');
    expect(charts.light).toContain('top 12 of 13 regressions');
    expect(charts.light).toContain('top 12 of 14 improvements');
    expect(charts.light).toContain('slower-12 · quickjs');
    expect(charts.light).not.toContain('slower-0 · quickjs');
    expect(charts.light).not.toContain('faster-13 · quickjs');
    expect(charts.light).toContain('100 → 142 ms');
    expect(charts.light).toContain('1 input/sample');
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
