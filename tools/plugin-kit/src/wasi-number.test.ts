import { describe, expect, it } from 'vitest';
import { toSafeNumber } from './wasi-number.ts';

describe('toSafeNumber', () => {
    it('converts values up to the largest safe integer', () => {
        expect(toSafeNumber(0n, 'size')).toBe(0);
        expect(toSafeNumber(1024n, 'size')).toBe(1024);
        expect(toSafeNumber(BigInt(Number.MAX_SAFE_INTEGER), 'size')).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('names the value it cannot convert', () => {
        expect(() => toSafeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 'WASI writable byte count')).toThrow(
            new RangeError("WASI writable byte count exceeds JavaScript's safe integer range"),
        );
        expect(() => toSafeNumber(2n ** 64n - 1n, 'data.bin size')).toThrow(RangeError);
    });

    it('rejects negative values', () => {
        expect(() => toSafeNumber(-1n, 'size')).toThrow(RangeError);
    });
});
