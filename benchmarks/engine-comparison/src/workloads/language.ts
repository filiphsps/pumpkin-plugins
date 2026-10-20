import type { WorkloadScenario } from '../benchmark-workloads.ts';

const NUMERIC_ITERATION_COUNT = 1_000_000;
const OBJECT_COUNT = 50_000;

/** Arithmetic and object workloads that give the plugin-style fixtures a baseline. */
export const LANGUAGE_WORKLOADS: readonly WorkloadScenario[] = [
    {
        name: 'numeric',
        area: 'Numeric arithmetic baseline',
        operationsPerSample: NUMERIC_ITERATION_COUNT,
        run: runNumeric,
    },
    { name: 'objects', area: 'Object allocation and traversal', operationsPerSample: OBJECT_COUNT, run: runObjects },
];

function runNumeric(): number {
    let value = 1;
    for (let index = 0; index < NUMERIC_ITERATION_COUNT; index++) {
        value = (value * 48_271 + index + 1) % 2_147_483_647;
    }
    return value + (Math.imul(0x811c9dc5, 16_777_619) >>> 0);
}

function runObjects(): number {
    const records: { id: number; value: number }[] = [];
    for (let id = 0; id < OBJECT_COUNT; id++) {
        records.push({ id, value: (id * 17) % 97 });
    }

    let total = 0;
    for (const record of records) {
        total = (total + record.id * record.value) >>> 0;
    }
    return total;
}
