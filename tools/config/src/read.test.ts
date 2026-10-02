import { describe, expect, it } from 'vitest';
import { demo } from '../test/schema.ts';
import { readConfig } from './read.ts';

describe('readConfig', () => {
    it('fills in defaults and reports what the file lacks', () => {
        const { values, issues } = readConfig(demo, {});
        expect(values).toEqual({ web: { enabled: true, port: 8123, base_url: '' }, overrides: {} });
        expect(issues.map((i) => [i.kind, i.path])).toEqual([
            ['missing', 'web.enabled'],
            ['missing', 'web.port'],
            ['missing', 'web.base_url']
        ]);
    });

    it('reads valid values', () => {
        const { values, issues } = readConfig(demo, {
            web: { enabled: false, port: 9000, base_url: 'https://x.test//', token: 't' },
            overrides: { 'a.txt': { order: 3 }, 'b.c.txt': { enabled: false } }
        });
        expect(issues).toEqual([]);
        expect(values).toEqual({
            web: { enabled: false, port: 9000, base_url: 'https://x.test', token: 't' },
            overrides: { 'a.txt': { order: 3 }, 'b.c.txt': { enabled: false } }
        });
    });

    it('falls back to the default and says which one for invalid values', () => {
        const { values, issues } = readConfig(demo, {
            web: { enabled: 'yes', port: 70000, base_url: 'ftp://x', token: 5 }
        });
        expect(values.web).toEqual({ enabled: true, port: 8123, base_url: '' });
        expect(issues.filter((i) => i.kind === 'invalid').map((i) => i.message)).toEqual([
            'web.enabled must be true or false; using true',
            'web.port must be a whole number from 1 to 65535; using 8123',
            'web.base_url must be an http:// or https:// URL; using ""',
            'web.token must be a string; ignoring it'
        ]);
    });

    it('reports unknown settings and sections', () => {
        const { issues } = readConfig(demo, {
            web: { enabled: true, port: 1, base_url: '', prot: 2 },
            extra: {},
            overrides: { 'a.txt': { ordr: 1 } }
        });
        expect(issues.filter((i) => i.kind === 'unknown').map((i) => i.message)).toEqual([
            'unknown option web.prot',
            'unknown option overrides."a.txt".ordr',
            'unknown section [extra]'
        ]);
    });

    it('rejects a section or entry that is not a table, keeping the rest', () => {
        const a = readConfig(demo, { web: 'oops', overrides: { 'a.txt': 1, 'b.txt': { order: 2 } } });
        expect(a.values.web).toEqual({ enabled: true, port: 8123, base_url: '' });
        expect(a.values.overrides).toEqual({ 'b.txt': { order: 2 } });
        expect(a.issues.filter((i) => i.kind === 'invalid').map((i) => i.message)).toEqual([
            '[web] must be a table; using the defaults',
            'overrides."a.txt" must be a table; ignoring it'
        ]);
    });

    it('drops an invalid optional setting instead of inventing a value', () => {
        const { values } = readConfig(demo, { overrides: { 'a.txt': { order: 'first', enabled: false } } });
        expect(values.overrides['a.txt']).toEqual({ enabled: false });
    });
});
