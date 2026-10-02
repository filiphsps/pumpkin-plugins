import { describe, expect, it } from 'vitest';
import { bool, int, str } from './fields.ts';

describe('bool', () => {
    it('accepts booleans only', () => {
        const f = bool({ description: 'd', default: true });
        expect(f.parse(false)).toEqual({ ok: true, value: false });
        expect(f.parse('true')).toEqual({ ok: false });
        expect(f.format(true)).toBe('true');
        expect(f.expected).toBe('true or false');
    });

    it('is optional without a default', () => {
        expect(bool({ description: 'd' }).default).toBeUndefined();
    });
});

describe('int', () => {
    it('accepts safe whole numbers inside the range', () => {
        const f = int({ description: 'd', default: 5, min: 1, max: 10 });
        expect(f.parse(10)).toEqual({ ok: true, value: 10 });
        expect(f.parse(11)).toEqual({ ok: false });
        expect(f.parse(0)).toEqual({ ok: false });
        expect(f.parse(1.5)).toEqual({ ok: false });
        expect(f.parse('3')).toEqual({ ok: false });
        expect(f.parse(2n)).toEqual({ ok: true, value: 2 });
        expect(f.parse(2n ** 60n)).toEqual({ ok: false });
    });

    it('describes its range in the expected text', () => {
        expect(int({ description: 'd', default: 1, min: 1, max: 9 }).expected).toBe('a whole number from 1 to 9');
        expect(int({ description: 'd', default: 1, min: 0 }).expected).toBe('a whole number of at least 0');
        expect(int({ description: 'd', default: 1, max: 9 }).expected).toBe('a whole number of at most 9');
        expect(int({ description: 'd', default: 1 }).expected).toBe('a whole number');
    });
});

describe('str', () => {
    it('writes TOML basic strings', () => {
        expect(str({ description: 'd', default: '' }).format('a "b" \\ c')).toBe('"a \\"b\\" \\\\ c"');
    });

    it('applies the check and normalizes accepted values', () => {
        const f = str({
            description: 'd',
            default: '',
            check: { expected: 'lowercase', test: (v) => v === v.toLowerCase(), normalize: (v) => v.trim() }
        });
        expect(f.parse(' ok ')).toEqual({ ok: true, value: 'ok' });
        expect(f.parse('NO')).toEqual({ ok: false });
        expect(f.parse(1)).toEqual({ ok: false });
        expect(f.expected).toBe('lowercase');
    });

    it('formats its example as a TOML literal', () => {
        expect(str({ description: 'd', example: 'secret' }).example).toBe('"secret"');
        expect(int({ description: 'd', example: 7 }).example).toBe('7');
    });
});
