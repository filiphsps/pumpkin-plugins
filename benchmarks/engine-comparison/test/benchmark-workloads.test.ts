import { expect, it } from 'vitest';
import { measureSyntheticWorkloads } from '../src/benchmark-workloads.ts';

it('pins string workload identifiers, operation counts, and checksums', () => {
    const stringWorkloads = measureSyntheticWorkloads()
        .filter(({ name }) =>
            ['string-join', 'string-radix-integer', 'string-join-unicode'].includes(name)
        )
        .map(({ name, operationsPerSample, checksum }) => ({ name, operationsPerSample, checksum }));

    expect(stringWorkloads).toEqual([
        { name: 'string-join', operationsPerSample: 1_600_000, checksum: 9_519_680 },
        { name: 'string-radix-integer', operationsPerSample: 25_000, checksum: 2_414_958 },
        { name: 'string-join-unicode', operationsPerSample: 7, checksum: 134 }
    ]);
});
