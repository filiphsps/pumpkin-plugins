import type { EngineResult } from '../src/benchmark-results.ts';
import type { BenchmarkWorkload } from '../src/benchmark-workloads.ts';

/** Builds a 1,000-byte engine result labeled with its id. */
export function engine(id: string, workloads: BenchmarkWorkload[]): EngineResult {
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

/** Builds a synthetic one-input workload whose area matches its name. */
export function workload(name: string, samplesMs: number[]): BenchmarkWorkload {
    return {
        area: name,
        checksum: 0,
        name,
        operationsPerSample: 1,
        provenance: 'synthetic guest fixture',
        samplesMs,
    };
}
