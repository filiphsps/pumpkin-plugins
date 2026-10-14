import { expect, it } from 'vitest';
import type { BenchmarkWorkload } from '../src/benchmark-workloads.ts';
import { type EngineResult, formatConsoleReport, formatReport } from './engine-comparison-report.ts';

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

    expect(report).toContain('| Engine | Production component size | Difference from Baseline |');
    expect(report).toContain('| Variant B | 1,500 bytes | +500 bytes (+50.00%) |');
    expect(report).toContain('| Variant C | 750 bytes | -250 bytes (-25.00%) |');
    expect(report).toContain('| synthetic | Example guest operation / renamed-fixture-v2 |');
    expect(report).toContain('| real | An unrelated host API method / host-call-v3 |');
    expect(report).toContain('| Average benchmark median (ms) | 6.00 | 7.50 | 9.00 |');
    expect(report.trimEnd().endsWith('| Average benchmark median (ms) | 6.00 | 7.50 | 9.00 |')).toBe(true);
    expect(
        report.split('\n').filter((line) => line.startsWith('| synthetic |') || line.startsWith('| real |')),
    ).toHaveLength(workloads.length);
});

it('formats a console report with aligned tables and dynamic workload labels', () => {
    const engines = [
        engine('baseline', 'Baseline', 1_000, [0, 0]),
        engine('variant-b', 'Variant B', 1_500, [1, 2]),
        engine('variant-c', 'Variant C', 750, [2, 4]),
    ];

    const report = formatConsoleReport(engines, 'baseline');
    const lines = report.split('\n');

    expect(report).toContain('synthetic | Example guest operation / renamed-fixture-v2 | 3 inputs/sample');
    expect(report).toContain('real | An unrelated host API method / host-call-v3 | 2 inputs/sample');
    expect(report).toMatch(/\|\s+6\.00\s+\|\s+7\.50\s+\|\s+9\.00\s+\|/);
    expect(report).not.toContain('###');

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line?.startsWith('+') && lines[index + 1]?.startsWith('|')) {
            expect(lines[index + 1]?.length).toBe(line.length);
        }
    }
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
