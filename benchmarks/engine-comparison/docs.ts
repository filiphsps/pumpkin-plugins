import { code, table } from '@pumpkin-plugins/docs/markdown';
import type { DocumentSpec } from '@pumpkin-plugins/docs/node';
import { formatInteger } from './src/benchmark-results.ts';
import { API_WORKLOAD, WORKLOADS } from './src/benchmark-workloads.ts';

const workloads = [
    ...WORKLOADS.map(({ area, name, operationsPerSample }) => ({ area, kind: 'Synthetic', name, operationsPerSample })),
    { ...API_WORKLOAD, kind: 'Real API' },
];

if (new Set(workloads.map(({ name }) => name)).size !== workloads.length) {
    throw new Error('Benchmark workload names must be unique');
}

const workloadRows = table(
    ['Kind', 'Workload', 'Inputs per sample', 'What it represents'],
    workloads.map(({ area, kind, name, operationsPerSample }) => [
        kind,
        code(name),
        formatInteger(operationsPerSample),
        area,
    ]),
);
const workloadSummary = `There are ${workloads.length} timed workloads: ${WORKLOADS.length} deterministic guest-side fixtures and 1 real Pumpkin API call.`;
const note = '<!-- Generated from benchmark-workloads.ts and benchmark-plugin.ts. Run `pnpm readme`. -->';

/** Documentation blocks generated from the benchmark workload definitions. */
export const documents = [
    {
        file: 'docs/benchmarking.md',
        blocks: {
            'workload-summary': workloadSummary,
            'workload-inventory': workloadRows,
        },
        note,
    },
] satisfies DocumentSpec[];
