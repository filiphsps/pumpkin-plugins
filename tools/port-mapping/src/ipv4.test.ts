import { describe, expect, it } from 'vitest';
import { formatIpv4, isPublicIpv4, parseIpv4 } from './ipv4.ts';

describe('parseIpv4', () => {
    it('reads dotted quads and rejects everything else', () => {
        expect(parseIpv4('192.168.1.1')).toEqual([192, 168, 1, 1]);
        expect(parseIpv4(' 10.0.0.1 ')).toEqual([10, 0, 0, 1]);
        for (const bad of ['', 'localhost', '1.2.3', '1.2.3.4.5', '256.1.1.1', '1.2.3.-4', '::1'])
            expect(parseIpv4(bad)).toBeUndefined();
        expect(formatIpv4([1, 2, 3, 4])).toBe('1.2.3.4');
    });
});

describe('isPublicIpv4', () => {
    it('is false for private, shared, loopback, link-local and reserved ranges', () => {
        for (const text of [
            '10.1.2.3',
            '172.16.0.1',
            '172.31.255.255',
            '192.168.0.9',
            '100.64.0.1',
            '100.127.255.255',
            '127.0.0.1',
            '169.254.1.1',
            '0.0.0.0',
            '224.0.0.1',
            '255.255.255.255',
            '192.0.2.1'
        ])
            expect(isPublicIpv4(parseIpv4(text) as never), text).toBe(false);
    });

    it('is true for addresses on the internet, including those next to private ranges', () => {
        for (const text of [
            '93.184.216.34',
            '8.8.8.8',
            '172.15.0.1',
            '172.32.0.1',
            '100.63.0.1',
            '100.128.0.1',
            '192.169.0.1'
        ])
            expect(isPublicIpv4(parseIpv4(text) as never), text).toBe(true);
    });
});
