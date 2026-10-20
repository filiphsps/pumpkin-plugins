import { describe, expect, it } from 'vitest';
import { formatDistance } from './format.ts';

describe('formatDistance', () => {
    it('rounds before choosing between meters and kilometers', () => {
        expect(formatDistance(999.4)).toBe('999m');
        expect(formatDistance(999.6)).toBe('1.0km');
        expect(formatDistance(12_345)).toBe('12.3km');
    });

    it('writes huge distances without an exponent', () => {
        expect(formatDistance(1e25)).toBe('10000000000000000000000.0km');
    });
});
