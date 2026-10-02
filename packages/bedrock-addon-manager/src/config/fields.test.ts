import { describe, expect, it } from 'vitest';
import { httpUrl, ipv4Address, relativeFolder } from './fields.ts';

describe('ipv4Address', () => {
    it('accepts dotted quads', () => {
        const f = ipv4Address({ description: 'd', default: '0.0.0.0' });
        expect(f.parse('127.0.0.1')).toEqual({ ok: true, value: '127.0.0.1' });
        expect(f.parse('localhost')).toEqual({ ok: false });
        expect(f.parse('::1')).toEqual({ ok: false });
    });
});

describe('httpUrl', () => {
    it('requires http or https and strips trailing slashes', () => {
        const f = httpUrl({ description: 'd', default: '', allowEmpty: true });
        expect(f.parse('https://packs.example.com//')).toEqual({ ok: true, value: 'https://packs.example.com' });
        expect(f.parse('http://127.0.0.1:8123')).toEqual({ ok: true, value: 'http://127.0.0.1:8123' });
        expect(f.parse('ftp://x')).toEqual({ ok: false });
        expect(f.parse('https://')).toEqual({ ok: false });
    });

    it('allows an empty value only when asked', () => {
        expect(httpUrl({ description: 'd', default: '', allowEmpty: true }).parse('')).toEqual({ ok: true, value: '' });
        expect(httpUrl({ description: 'd' }).parse('')).toEqual({ ok: false });
    });
});

describe('relativeFolder', () => {
    const f = relativeFolder({ description: 'd', default: 'packs' });

    it('accepts folders inside the data folder and trims trailing slashes', () => {
        expect(f.parse('my/packs/')).toEqual({ ok: true, value: 'my/packs' });
    });

    it('rejects anything that could leave it', () => {
        for (const bad of ['', '/etc', '../up', 'a/../b', 'a\\b']) expect(f.parse(bad)).toEqual({ ok: false });
    });
});
