import { describe, expect, it } from 'vitest';
import { numberifyBigints } from './types.ts';

describe('numberifyBigints', () => {
    it('rewrites bigint to number in declarations', () => {
        expect(numberifyBigints('read(len: bigint, offset: bigint): [Uint8Array, boolean];')).toBe(
            'read(len: number, offset: number): [Uint8Array, boolean];'
        );
    });

    it('leaves longer identifiers and comments about BigInt values alone', () => {
        expect(numberifyBigints('type BigintLike = string; // a bigintish name')).toBe(
            'type BigintLike = string; // a bigintish name'
        );
    });
});
