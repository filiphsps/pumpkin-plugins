import type { BenchmarkWorkload } from './benchmark-workloads.ts';

/** Pumpkin API behavior counters every engine reports alongside its workload timings. */
export const API_BEHAVIOR_KEYS = [
    'eventRegistrations',
    'eventDispatches',
    'scheduledTasks',
    'scheduledCallbacks',
    'permissionRegistrations',
    'commandRegistrations',
    'commandDispatches',
    'serverQueries',
    'playersObserved',
] as const;

/** Benchmark output and component metadata for one engine configuration. */
export interface EngineResult {
    apiBehavior: Record<(typeof API_BEHAVIOR_KEYS)[number], number>;
    binarySizeBytes: number;
    id: string;
    label: string;
    runtimeSourceCompilation: boolean;
    unicodePropertyEscapes: boolean;
    workloads: BenchmarkWorkload[];
}

/** Formats an integer with en-US digit grouping, so reports read the same on every host locale. */
export const formatInteger = new Intl.NumberFormat('en-US').format;

/**
 * Returns the median sample; for an even count, the mean of the two middle samples.
 *
 * @throws When there are no samples.
 */
export function median(samples: readonly number[]): number {
    const ordered = [...samples].sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    const upper = ordered[middle];
    if (upper === undefined) throw new Error('Cannot take the median of no samples');
    return ordered.length % 2 === 1 ? upper : ((ordered[middle - 1] ?? upper) + upper) / 2;
}

/**
 * Indexes an engine's workloads by name.
 *
 * @throws When a workload name repeats or a workload has no samples.
 */
export function indexWorkloads(engine: EngineResult): Map<string, BenchmarkWorkload> {
    const indexed = new Map<string, BenchmarkWorkload>();
    for (const workload of engine.workloads) {
        if (indexed.has(workload.name)) throw new Error(`${engine.label} reports duplicate workload ${workload.name}`);
        if (workload.samplesMs.length === 0)
            throw new Error(`${engine.label} workload ${workload.name} has no samples`);
        indexed.set(workload.name, workload);
    }
    return indexed;
}

/** Returns whether two runs of a workload measured the same inputs and produced the same checksum. */
export function sameWorkloadDefinition(left: BenchmarkWorkload, right: BenchmarkWorkload): boolean {
    return (
        left.area === right.area &&
        left.provenance === right.provenance &&
        left.operationsPerSample === right.operationsPerSample &&
        left.checksum === right.checksum
    );
}

/**
 * Checks that every engine ran the same workloads as the baseline with the same API behavior,
 * inputs, checksums and sample counts.
 *
 * @param baseline - Engine the others are compared with; defaults to the first engine.
 * @throws When the results are empty or any engine differs from the baseline.
 */
export function validateMatchingResults(engines: readonly EngineResult[], baseline = engines[0]): void {
    if (!baseline) throw new Error('Engine comparison has no results');
    if (new Set(engines.map(({ id }) => id)).size !== engines.length) {
        throw new Error('Engine comparison contains duplicate engine IDs');
    }
    const baselineWorkloads = indexWorkloads(baseline);
    if (baselineWorkloads.size === 0) throw new Error(`${baseline.label} reports no workloads`);

    for (const engine of engines) {
        if (API_BEHAVIOR_KEYS.some((key) => engine.apiBehavior[key] !== baseline.apiBehavior[key])) {
            throw new Error(`${engine.label} API behavior differs from ${baseline.label}`);
        }

        const workloads = indexWorkloads(engine);
        if (workloads.size !== baselineWorkloads.size) {
            throw new Error(`${engine.label} does not report the same workloads as ${baseline.label}`);
        }
        for (const [name, expected] of baselineWorkloads) {
            const actual = workloads.get(name);
            if (!actual) throw new Error(`${engine.label} is missing workload ${name}`);
            if (!sameWorkloadDefinition(actual, expected)) {
                throw new Error(`${engine.label} workload ${name} does not match ${baseline.label}`);
            }
            if (
                actual.samplesMs.length !== expected.samplesMs.length ||
                actual.samplesMs.some((sample) => !Number.isFinite(sample) || sample < 0)
            ) {
                throw new Error(`${engine.label} workload ${name} has invalid timing samples`);
            }
        }
    }
}
