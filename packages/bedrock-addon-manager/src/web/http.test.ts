import { strFromU8, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { MAX_REQUEST_BYTES, parseRange, parseRequest, responseHead, routePack } from './http.ts';

const request = (text: string) => parseRequest(strToU8(text));

describe('parseRequest', () => {
    it('reads the method, target and lowercased headers', () => {
        expect(request('GET /packs/a.mcpack HTTP/1.1\r\nHost: x\r\nRange: bytes=0-9\r\n\r\n')).toEqual({
            method: 'GET',
            target: '/packs/a.mcpack',
            headers: { host: 'x', range: 'bytes=0-9' }
        });
    });

    it('waits for the blank line', () => {
        expect(request('GET / HTTP/1.1\r\nHost: x\r\n')).toBe('incomplete');
        expect(request('')).toBe('incomplete');
    });

    it('rejects malformed requests', () => {
        expect(request('GARBAGE\r\n\r\n')).toBe('bad');
        expect(request('get / HTTP/1.1\r\n\r\n')).toBe('bad');
        expect(request('GET / HTTP/2.0\r\n\r\n')).toBe('bad');
        expect(request('GET / HTTP/1.1\r\nno-colon\r\n\r\n')).toBe('bad');
    });

    it('gives up on a head that never ends', () => {
        expect(parseRequest(new Uint8Array(MAX_REQUEST_BYTES).fill(65))).toBe('bad');
    });

    it('ignores anything after the head', () => {
        expect(request('GET / HTTP/1.1\r\n\r\nbody')).toMatchObject({ method: 'GET' });
    });
});

describe('routePack', () => {
    it('decodes the pack name', () => {
        expect(routePack('/packs/My%20Pack.mcpack')).toBe('My Pack.mcpack');
        expect(routePack('/packs/ü.mcpack?x=1#y')).toBe('ü.mcpack');
        expect(routePack('/packs/%C3%BC.mcpack')).toBe('ü.mcpack');
    });

    it('rejects anything that is not a plain file name under /packs/', () => {
        for (const target of [
            '/',
            '/packs',
            '/packs/',
            '/other/a.mcpack',
            '/packs/..',
            '/packs/.',
            '/packs/../config.toml',
            '/packs/..%2Fconfig.toml',
            '/packs/%2e%2e%2fconfig.toml',
            '/packs/a%2Fb',
            '/packs/a%5Cb',
            '/packs/a%00b',
            '/packs/%E0%A4%A'
        ]) {
            expect(routePack(target), target).toBeNull();
        }
    });
});

describe('parseRange', () => {
    it('reads closed, open-ended and suffix ranges, clamping to the file', () => {
        expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
        expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
        expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
        expect(parseRange('bytes=-5', 100)).toEqual({ start: 95, end: 99 });
        expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
    });

    it('reports ranges that start past the end as unsatisfiable', () => {
        expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
        expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
        expect(parseRange('bytes=0-0', 0)).toBe('unsatisfiable');
    });

    it('ignores headers it does not understand so the whole file is served', () => {
        for (const header of [undefined, '', 'bytes=', 'bytes=0-1,5-6', 'items=0-1', 'bytes=9-3', 'bytes=a-b']) {
            expect(parseRange(header, 100), String(header)).toBeUndefined();
        }
    });
});

describe('responseHead', () => {
    it('writes the status line, headers and always closes the connection', () => {
        expect(strFromU8(responseHead(206, { 'Content-Length': 10 }))).toBe(
            'HTTP/1.1 206 Partial Content\r\nContent-Length: 10\r\nConnection: close\r\n\r\n'
        );
    });
});
