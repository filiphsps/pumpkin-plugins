import { expect, it } from 'vitest';
import { WORKLOADS } from './benchmark-workloads.ts';

it('pins string workload identifiers, operation counts, and checksums', () => {
    const stringWorkloads = WORKLOADS.filter(({ name }) =>
        [
            'string-join',
            'string-radix-integer',
            'string-join-unicode',
            'string-repeat-ascii',
            'string-pad-ascii',
            'array-to-locale-string-ascii',
        ].includes(name),
    ).map(({ name, operationsPerSample, run }) => ({ name, operationsPerSample, checksum: run() }));

    expect(stringWorkloads).toEqual([
        { name: 'string-join', operationsPerSample: 1_600_000, checksum: 9_519_680 },
        { name: 'string-radix-integer', operationsPerSample: 25_000, checksum: 2_414_958 },
        { name: 'string-join-unicode', operationsPerSample: 7, checksum: 134 },
        { name: 'string-repeat-ascii', operationsPerSample: 4_000, checksum: 2_448_000 },
        { name: 'string-pad-ascii', operationsPerSample: 8_000, checksum: 2_432_000 },
        { name: 'array-to-locale-string-ascii', operationsPerSample: 32_000, checksum: 2_872_000 },
    ]);
});

it('pins the additional Hermes string fast-path workloads', () => {
    const stringWorkloads = WORKLOADS.filter(({ name }) =>
        [
            'string-case-ascii',
            'typed-array-join-ascii',
            'typed-array-locale-ascii',
            'string-from-char-code-ascii',
            'string-replace-ascii',
        ].includes(name),
    ).map(({ name, operationsPerSample, run }) => ({ name, operationsPerSample, checksum: run() }));

    expect(stringWorkloads).toEqual([
        { name: 'string-case-ascii', operationsPerSample: 16_000, checksum: 1_408_000 },
        { name: 'typed-array-join-ascii', operationsPerSample: 128_000, checksum: 544_000 },
        { name: 'typed-array-locale-ascii', operationsPerSample: 64_000, checksum: 368_000 },
        { name: 'string-from-char-code-ascii', operationsPerSample: 8_000, checksum: 680_000 },
        { name: 'string-replace-ascii', operationsPerSample: 16_000, checksum: 1_568_000 },
    ]);
});
