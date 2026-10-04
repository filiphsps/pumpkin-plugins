import { describe, expect, it } from 'vitest';
import { boolPayload, floatPayload } from './payload.ts';

describe('floatPayload', () => {
    it('writes a big-endian 32-bit float, the way the client reads it', () => {
        expect([...floatPayload(1)]).toEqual([0x3f, 0x80, 0x00, 0x00]);
        expect([...floatPayload(-2)]).toEqual([0xc0, 0x00, 0x00, 0x00]);
    });

    it('keeps the fraction a saturation level usually has', () => {
        const read = new DataView(floatPayload(5.5).buffer).getFloat32(0);
        expect(read).toBe(5.5);
    });

    it('round-trips the values a hunger manager reports, to the nearest 32-bit float', () => {
        for (const value of [0, 1, 4.2, 19.999, 1000.25]) {
            expect(new DataView(floatPayload(value).buffer).getFloat32(0)).toBe(Math.fround(value));
        }
    });
});

describe('boolPayload', () => {
    it('writes one byte per flag, as the client reads it', () => {
        expect([...boolPayload(true)]).toEqual([1]);
        expect([...boolPayload(false)]).toEqual([0]);
    });
});
