import { expect, it } from 'vitest';
import type { EngineResult } from './benchmark-results.ts';
import type { BenchmarkWorkload } from './benchmark-workloads.ts';
import { formatConsoleReport, formatReport } from './engine-comparison-report.ts';

const workloads: BenchmarkWorkload[] = [
    {
        name: 'renamed-fixture-v2',
        area: 'Example guest operation',
        provenance: 'synthetic guest fixture',
        operationsPerSample: 3,
        samplesMs: [2, 4, 6],
        checksum: 11,
    },
    {
        name: 'host-call-v3',
        area: 'An unrelated host API method',
        provenance: 'real Pumpkin API',
        operationsPerSample: 2,
        samplesMs: [6, 8, 10],
        checksum: 0,
    },
];

it('formats arbitrary workload metadata and averages every workload median', () => {
    const engines = [
        engine('baseline', 'Baseline', 1_000, [0, 0]),
        engine('variant-b', 'Variant B', 1_500, [1, 2]),
        engine('variant-c', 'Variant C', 750, [2, 4]),
    ];
    engines[2]?.workloads.reverse();

    const report = formatReport(engines, 'baseline');
    const averageSectionStart = report.indexOf('Average performance across all benchmarks');
    const averageSection = report.slice(averageSectionStart);

    expect(averageSectionStart).toBeGreaterThanOrEqual(0);
    expect(report).toContain('Variant B');
    expect(report).toContain('Variant C');
    expect(report).toContain('1,500 bytes');
    expect(report).toContain('750 bytes');
    expect(report).toContain('renamed-fixture-v2');
    expect(report).toContain('host-call-v3');
    expect(report).toContain('Example guest operation');
    expect(report).toContain('An unrelated host API method');
    expect(report).toContain('+500 bytes');
    expect(report).toContain('50.00%');
    expect(report).toContain('-250 bytes');
    expect(report).toContain('-25.00%');
    expect(report).toContain('0.80x');
    expect(report).toContain('0.67x');
    expect(averageSection).toContain('6.00');
    expect(averageSection).toContain('7.50');
    expect(averageSection).toContain('9.00');
});

it('formats a console report with aligned tables and dynamic workload labels', () => {
    const engines = [
        engine('baseline', 'Baseline', 1_000, [0, 0]),
        engine('variant-b', 'Variant B', 1_500, [1, 2]),
        engine('variant-c', 'Variant C', 750, [2, 4]),
    ];

    const report = formatConsoleReport(engines, 'baseline');
    const lines = report.split('\n');
    const averageSection = report.slice(report.indexOf('Average performance across all benchmarks'));

    expect(report).toContain('Example guest operation');
    expect(report).toContain('renamed-fixture-v2');
    expect(report).toContain('An unrelated host API method');
    expect(report).toContain('host-call-v3');
    expect(averageSection).toContain('6.00');
    expect(averageSection).toContain('7.50');
    expect(averageSection).toContain('9.00');

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line?.startsWith('+') && lines[index + 1]?.startsWith('|')) {
            expect(lines[index + 1]?.length).toBe(line.length);
        }
    }
});

it('reports the mean of the two middle samples as the median of an even sample count', () => {
    const engines = [engine('baseline', 'Baseline', 1_000, [0, 0]), engine('variant-b', 'Variant B', 1_000, [0, 0])];
    for (const result of engines) {
        for (const workload of result.workloads) workload.samplesMs = [4, 1, 3, 2];
    }

    expect(formatReport(engines, 'baseline')).toContain('2.50 ms (1.00–4.00 ms)');
});

function engine(id: string, label: string, binarySizeBytes: number, offsets: number[]): EngineResult {
    return {
        id,
        label,
        binarySizeBytes,
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
        runtimeSourceCompilation: true,
        unicodePropertyEscapes: true,
        workloads: workloads.map((workload, index) => ({
            ...workload,
            samplesMs: workload.samplesMs.map((sample) => sample + (offsets[index] ?? 0)),
        })),
    };
}
