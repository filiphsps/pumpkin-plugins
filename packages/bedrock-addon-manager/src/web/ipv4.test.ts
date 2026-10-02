import { describe, expect, it } from 'vitest';
import { parseIpv4 } from './ipv4.ts';

describe('parseIpv4', () => {
    it('accepts dotted quads only', () => {
        expect(parseIpv4('10.0.0.255')).toEqual([10, 0, 0, 255]);
        for (const bad of ['', '1.2.3', '1.2.3.4.5', '256.0.0.1', 'a.b.c.d', '::1', '1.2.3.-4']) {
            expect(parseIpv4(bad)).toBeUndefined();
        }
    });
});
