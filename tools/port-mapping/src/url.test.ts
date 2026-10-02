import { describe, expect, it } from 'vitest';
import { parseHttpUrl, resolveUrl } from './url.ts';

describe('parseHttpUrl', () => {
    it('reads http URLs with an IPv4 host', () => {
        expect(parseHttpUrl('http://192.168.1.1:5000/rootDesc.xml')).toEqual({
            endpoint: { address: [192, 168, 1, 1], port: 5000 },
            path: '/rootDesc.xml'
        });
        expect(parseHttpUrl('http://10.0.0.1')).toEqual({ endpoint: { address: [10, 0, 0, 1], port: 80 }, path: '/' });
        expect(parseHttpUrl('http://10.0.0.1:80/a?b=c#d')?.path).toBe('/a?b=c');
    });

    it('rejects https, host names, IPv6 and bad ports', () => {
        for (const bad of [
            'https://10.0.0.1/',
            'http://router.local/',
            'http://[::1]/',
            'http://10.0.0.1:99999/',
            'ftp://10.0.0.1',
            'x'
        ])
            expect(parseHttpUrl(bad)).toBeUndefined();
    });
});

describe('resolveUrl', () => {
    it('keeps absolute URLs and resolves paths against the document', () => {
        expect(resolveUrl('http://1.2.3.4/x', 'http://5.6.7.8/y')).toBe('http://1.2.3.4/x');
        expect(resolveUrl('/ctl/IPConn', 'http://192.168.1.1:5000/rootDesc.xml')).toBe(
            'http://192.168.1.1:5000/ctl/IPConn'
        );
        expect(resolveUrl('ctl', 'http://192.168.1.1:5000/desc/root.xml?x=1')).toBe('http://192.168.1.1:5000/desc/ctl');
        expect(resolveUrl('ctl', 'http://192.168.1.1:5000')).toBe('http://192.168.1.1:5000/ctl');
    });
});
