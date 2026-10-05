import { describe, expect, it } from 'vitest';
import { bool, float32be } from './payload.ts';

describe(float32be.name, () => {
    it('writes a big-endian 32-bit float', () => {
        expect([...float32be(1)]).toEqual([0x3f, 0x80, 0x00, 0x00]);
        expect([...float32be(-2)]).toEqual([0xc0, 0x00, 0x00, 0x00]);
    });

    it('keeps the nearest value the 32-bit format holds', () => {
        for (const value of [0, 1, 4.2, 19.999, 1000.25]) {
            expect(new DataView(float32be(value).buffer).getFloat32(0)).toBe(Math.fround(value));
        }
    });
});

describe(bool.name, () => {
    it('writes one byte per flag', () => {
        expect([...bool(true)]).toEqual([1]);
        expect([...bool(false)]).toEqual([0]);
    });
});
