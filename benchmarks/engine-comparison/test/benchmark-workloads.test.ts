import { expect, it } from 'vitest';
import { measureSyntheticWorkloads } from '../src/benchmark-workloads.ts';

it('pins string workload identifiers, operation counts, and checksums', () => {
    const stringWorkloads = measureSyntheticWorkloads()
        .filter(({ name }) =>
            [
                'string-join',
                'string-radix-integer',
                'string-join-unicode',
                'string-repeat-ascii',
                'string-pad-ascii',
                'array-to-locale-string-ascii',
            ].includes(name),
        )
        .map(({ name, operationsPerSample, checksum }) => ({ name, operationsPerSample, checksum }));

    expect(stringWorkloads).toEqual([
        { name: 'string-join', operationsPerSample: 1_600_000, checksum: 9_519_680 },
        { name: 'string-radix-integer', operationsPerSample: 25_000, checksum: 2_414_958 },
        { name: 'string-join-unicode', operationsPerSample: 7, checksum: 134 },
        { name: 'string-repeat-ascii', operationsPerSample: 4_000, checksum: 2_448_000 },
        { name: 'string-pad-ascii', operationsPerSample: 8_000, checksum: 2_432_000 },
        { name: 'array-to-locale-string-ascii', operationsPerSample: 32_000, checksum: 2_872_000 },
    ]);
}, 30_000);
