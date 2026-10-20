// biome-ignore assist/source/organizeImports: modules run in import order, which sets the fixture allocation order baked into the QuickJS snapshot and its component size.
import { LANGUAGE_WORKLOADS } from './workloads/language.ts';
import { STRING_WORKLOADS } from './workloads/strings.ts';
import { CONFIG_WORKLOADS } from './workloads/config.ts';
import { COMMAND_WORKLOADS } from './workloads/commands.ts';
import { PERMISSION_WORKLOADS } from './workloads/permissions.ts';
import { PLAYER_WORKLOADS } from './workloads/players.ts';
import { CHAT_WORKLOADS } from './workloads/chat.ts';
import { WORLD_WORKLOADS } from './workloads/world.ts';
import { GAMEPLAY_WORKLOADS } from './workloads/gameplay.ts';
import { STORAGE_WORKLOADS } from './workloads/storage.ts';

/** Describes whether a workload uses a guest-side fixture or the real Pumpkin API. */
export type WorkloadProvenance = 'synthetic guest fixture' | 'real Pumpkin API';

/** Timings and deterministic output for one measured workload. */
export interface BenchmarkWorkload {
    /** Human-readable description of the algorithm being measured. */
    area: string;
    /** Deterministic result used to confirm equivalent work across runtimes. */
    checksum: number;
    /** Stable identifier used to compare the same workload across runtimes. */
    name: string;
    /** Input items or requests processed by each timed sample. */
    operationsPerSample: number;
    /** Whether the workload is a guest fixture or uses a real Pumpkin API call. */
    provenance: WorkloadProvenance;
    /** Elapsed time in milliseconds for each measured run, after warm-up. */
    samplesMs: number[];
}

/** A workload definition: its metadata and a run that returns a deterministic checksum. */
export type WorkloadScenario = Pick<BenchmarkWorkload, 'name' | 'area' | 'operationsPerSample'> & {
    run: () => number;
};

/** Number of timed runs for each workload, after one un-timed warm-up. */
const SAMPLE_COUNT = 5;

/** Number of `server.getAllPlayers()` calls in each sample of the real Pumpkin API workload. */
export const PLAYER_QUERIES_PER_SAMPLE = 10_000;

/** Metadata for the real Pumpkin API workload that benchmark-plugin.ts times on the server. */
export const API_WORKLOAD = {
    name: 'pumpkin-api',
    area: 'Pumpkin server.getAllPlayers()',
    operationsPerSample: PLAYER_QUERIES_PER_SAMPLE,
} as const;

/** Every deterministic guest-side workload, in report order. */
export const WORKLOADS: readonly WorkloadScenario[] = [
    ...LANGUAGE_WORKLOADS,
    ...STRING_WORKLOADS,
    ...CONFIG_WORKLOADS,
    ...COMMAND_WORKLOADS,
    ...PERMISSION_WORKLOADS,
    ...PLAYER_WORKLOADS,
    ...CHAT_WORKLOADS,
    ...WORLD_WORKLOADS,
    ...GAMEPLAY_WORKLOADS,
    ...STORAGE_WORKLOADS,
];

/** Runs and measures every deterministic plugin-style workload. */
export function measureSyntheticWorkloads(): BenchmarkWorkload[] {
    return WORKLOADS.map(({ name, area, operationsPerSample, run }) =>
        measureWorkload(name, area, 'synthetic guest fixture', operationsPerSample, run),
    );
}

/**
 * Measures one workload after a warm-up run.
 * @param name - Stable workload identifier.
 * @param area - Algorithm represented by the workload.
 * @param provenance - Whether this measures a synthetic fixture or real Pumpkin API behavior.
 * @param operationsPerSample - Number of inputs processed in each timed run.
 * @param run - Runs the workload and returns a deterministic checksum.
 * @returns The timed samples and final checksum.
 */
export function measureWorkload(
    name: string,
    area: string,
    provenance: WorkloadProvenance,
    operationsPerSample: number,
    run: () => number,
): BenchmarkWorkload {
    run();
    let checksum = 0;
    const samplesMs: number[] = [];
    for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
        const startedAt = Date.now();
        checksum = run();
        samplesMs.push(Date.now() - startedAt);
    }
    return { name, area, provenance, operationsPerSample, samplesMs, checksum };
}
