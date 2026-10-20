import { type EngineResult, indexWorkloads, median, sameWorkloadDefinition } from './benchmark-results.ts';
import type { BenchmarkWorkload } from './benchmark-workloads.ts';

/** How one workload timing moved against the baseline once runner jitter is ignored. */
export type BenchmarkChangeStatus = 'regression' | 'improvement' | 'within-jitter';

/** Overall tone of the pull request comment: any regression warns, otherwise any improvement celebrates. */
export type BenchmarkCommentStatus = 'warning' | 'celebration' | 'regular';

/** Smallest absolute median change, in milliseconds, that can count as a regression or improvement. */
export const MINIMUM_CHANGE_MS = 1;

/** A workload timing compared with the same engine and workload in the baseline run. */
export interface BenchmarkChange {
    baselineMedianMs: number;
    changePercent: number;
    currentMedianMs: number;
    engineId: string;
    engineLabel: string;
    operationsPerSample: number;
    status: BenchmarkChangeStatus;
    workload: string;
    workloadArea: string;
    workloadProvenance: BenchmarkWorkload['provenance'];
}

/** Component size for one engine in the current benchmark run. */
export interface BenchmarkEngineSize {
    binarySizeBytes: number;
    engineId: string;
    engineLabel: string;
}

/** Per-workload timing changes grouped by their effect size. */
export interface BenchmarkComparison {
    changes: BenchmarkChange[];
    engineSizes: BenchmarkEngineSize[];
    improvements: BenchmarkChange[];
    medianChangePercent: number | null;
    regressions: BenchmarkChange[];
    skippedWorkloads: string[];
    status: BenchmarkCommentStatus;
    thresholdPercent: number;
}

/**
 * Compares workload medians from matching engine configurations and classifies changes beyond the jitter threshold.
 * A change smaller than {@link MINIMUM_CHANGE_MS} counts as jitter whatever its percentage.
 *
 * @param current - Results produced by the current revision.
 * @param baseline - Results produced by the baseline revision.
 * @param thresholdPercent - Minimum absolute timing change, in percent, that counts as significant.
 * @returns Comparable timing changes, skipped rows, and an overall comment status.
 */
export function compareBenchmarkResults(
    current: readonly EngineResult[],
    baseline: readonly EngineResult[],
    thresholdPercent = 10,
): BenchmarkComparison {
    if (!Number.isFinite(thresholdPercent) || thresholdPercent < 0 || thresholdPercent > 100) {
        throw new Error('Benchmark jitter threshold must be a finite percentage from 0 through 100');
    }

    const currentEngines = indexEngines(current, 'current');
    const baselineEngines = indexEngines(baseline, 'baseline');
    const changes: BenchmarkChange[] = [];
    const skippedWorkloads: string[] = [];

    for (const engine of current) {
        const baselineEngine = baselineEngines.get(engine.id);
        if (!baselineEngine) {
            if (baseline.length > 0) skippedWorkloads.push(`${engine.id}: engine is not present in baseline`);
            continue;
        }

        const currentWorkloads = indexWorkloads(engine);
        const baselineWorkloads = indexWorkloads(baselineEngine);
        for (const workload of engine.workloads) {
            const baselineWorkload = baselineWorkloads.get(workload.name);
            if (!baselineWorkload) {
                skippedWorkloads.push(`${engine.id}/${workload.name}: workload is not present in baseline`);
                continue;
            }
            if (!sameWorkloadDefinition(workload, baselineWorkload)) {
                skippedWorkloads.push(`${engine.id}/${workload.name}: workload definition changed`);
                continue;
            }

            const baselineMedianMs = median(baselineWorkload.samplesMs);
            if (baselineMedianMs === 0) {
                skippedWorkloads.push(`${engine.id}/${workload.name}: baseline median is 0 ms`);
                continue;
            }

            const currentMedianMs = median(workload.samplesMs);
            const changePercent = ((currentMedianMs - baselineMedianMs) / baselineMedianMs) * 100;
            const significant = Math.abs(currentMedianMs - baselineMedianMs) >= MINIMUM_CHANGE_MS;
            changes.push({
                baselineMedianMs,
                changePercent,
                currentMedianMs,
                engineId: engine.id,
                engineLabel: engine.label,
                operationsPerSample: workload.operationsPerSample,
                status: !significant
                    ? 'within-jitter'
                    : changePercent > thresholdPercent
                      ? 'regression'
                      : changePercent < -thresholdPercent
                        ? 'improvement'
                        : 'within-jitter',
                workloadArea: workload.area,
                workload: workload.name,
                workloadProvenance: workload.provenance,
            });
        }

        for (const workload of baselineEngine.workloads) {
            if (!currentWorkloads.has(workload.name)) {
                skippedWorkloads.push(`${engine.id}/${workload.name}: workload is not present in current run`);
            }
        }
    }

    for (const engine of baseline) {
        if (!currentEngines.has(engine.id)) skippedWorkloads.push(`${engine.id}: engine is not present in current run`);
    }

    const regressions = changes.filter(({ status }) => status === 'regression').sort(compareLargestFirst);
    const improvements = changes
        .filter(({ status }) => status === 'improvement')
        .sort((left, right) => left.changePercent - right.changePercent);

    return {
        changes,
        engineSizes: current.map(({ binarySizeBytes, id, label }) => ({
            binarySizeBytes,
            engineId: id,
            engineLabel: label,
        })),
        improvements,
        medianChangePercent: changes.length > 0 ? median(changes.map(({ changePercent }) => changePercent)) : null,
        regressions,
        skippedWorkloads,
        status: regressions.length > 0 ? 'warning' : improvements.length > 0 ? 'celebration' : 'regular',
        thresholdPercent,
    };
}

/** Formats a timing change percentage to one decimal place for the PR comment and chart. */
export function formatSignedPercent(value: number): string {
    return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(1)}%`;
}

function indexEngines(engines: readonly EngineResult[], revision: string): Map<string, EngineResult> {
    const indexed = new Map<string, EngineResult>();
    for (const engine of engines) {
        if (indexed.has(engine.id)) throw new Error(`${revision} results contain duplicate engine ${engine.id}`);
        indexed.set(engine.id, engine);
    }
    return indexed;
}

function compareLargestFirst(left: BenchmarkChange, right: BenchmarkChange): number {
    return right.changePercent - left.changePercent;
}
