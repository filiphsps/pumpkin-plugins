import { expect, it } from 'vitest';
import { engine, workload } from '../test/benchmark-fixtures.ts';
import { formatBenchmarkChangeSvgs } from './benchmark-chart.ts';
import { compareBenchmarkResults } from './benchmark-regression.ts';

it('renders a labeled SVG chart for the largest changes', () => {
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

    const svg = formatBenchmarkChangeSvgs(comparison).light;

    expect(svg).toContain('<svg');
    expect(svg).toContain('Runtime benchmark changes');
    expect(svg).toContain('slower · quickjs');
    expect(svg).toContain('faster · quickjs');
    expect(svg).toContain('±10%');
    expect(svg).not.toContain('<script>');
});

it('renders light and dark SVGs with full context and caps each timing direction at twelve rows', () => {
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

    const charts = formatBenchmarkChangeSvgs(comparison);

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
