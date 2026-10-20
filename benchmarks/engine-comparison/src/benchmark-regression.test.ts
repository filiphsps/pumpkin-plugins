import { expect, it } from 'vitest';
import { engine, workload } from '../test/benchmark-fixtures.ts';
import { compareBenchmarkResults, formatSignedPercent } from './benchmark-regression.ts';

it('flags workload changes only when they exceed the jitter threshold', () => {
    const baseline = [engine('quickjs', [workload('stable', [100]), workload('slower', [100])])];
    const current = [engine('quickjs', [workload('stable', [110]), workload('slower', [111])])];
    const comparison = compareBenchmarkResults(current, baseline, 10);

    expect(comparison.status).toBe('warning');
    expect(comparison.regressions.map(({ workload: name }) => name)).toEqual(['slower']);
    expect(comparison.changes.find(({ workload: name }) => name === 'stable')?.status).toBe('within-jitter');
});

it('treats median changes under one millisecond as jitter even when the percentage is large', () => {
    const baseline = [engine('quickjs', [workload('tiny', [2]), workload('large', [20])])];
    const current = [engine('quickjs', [workload('tiny', [2.8]), workload('large', [28])])];
    const comparison = compareBenchmarkResults(current, baseline, 10);

    expect(comparison.changes.find(({ workload: name }) => name === 'tiny')?.status).toBe('within-jitter');
    expect(comparison.regressions.map(({ workload: name }) => name)).toEqual(['large']);
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

it('reports component sizes without skipped rows when there is no baseline run', () => {
    const comparison = compareBenchmarkResults([engine('quickjs', [workload('stable', [100])])], []);

    expect(comparison.status).toBe('regular');
    expect(comparison.changes).toEqual([]);
    expect(comparison.skippedWorkloads).toEqual([]);
    expect(comparison.engineSizes).toEqual([{ binarySizeBytes: 1_000, engineId: 'quickjs', engineLabel: 'quickjs' }]);
});

it('prints one sign for negative, zero and positive percentage changes', () => {
    expect(formatSignedPercent(-3.84)).toBe('−3.8%');
    expect(formatSignedPercent(0)).toBe('0.0%');
    expect(formatSignedPercent(12.34)).toBe('+12.3%');
});
