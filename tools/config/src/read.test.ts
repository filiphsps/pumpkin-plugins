import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { mutableValueField } from '../test/mutable-value.ts';
import { demo } from '../test/schema.ts';
import { readConfig } from './read.ts';
import { defineConfig, section, table } from './schema.ts';

describe('readConfig', () => {
    it('fills in defaults and reports what the file lacks', () => {
        const { values, issues } = readConfig(demo, {});
        expect(values).toEqual({ web: { enabled: true, port: 8123, base_url: '' }, overrides: {} });
        expect(issues.map((i) => [i.kind, i.path])).toEqual([
            ['missing', 'web.enabled'],
            ['missing', 'web.port'],
            ['missing', 'web.base_url'],
        ]);
    });

    it('returns an independent structured default when a section field is absent', () => {
        const schema = defineConfig('Demo', {
            settings: section({
                description: 'General settings.',
                fields: { policy: mutableValueField() },
            }),
        });

        const first = readConfig(schema, {});
        first.values.settings.policy?.nested.levels.push(3);
        first.values.settings.policy?.nested.timestamp.setUTCFullYear(2000);

        expect(readConfig(schema, {}).values.settings.policy).toEqual({
            nested: { levels: [1, 2], timestamp: new Date('2025-01-02T03:04:05.000Z') },
        });
    });

    it('returns an independent structured default for a missing table-entry field', () => {
        const schema = defineConfig('Demo', {
            sources: table({
                description: 'Configured sources.',
                entryName: 'source',
                exampleKey: 'torch',
                fields: { policy: mutableValueField() },
            }),
        });

        const first = readConfig(schema, { sources: { torch: {} } });
        first.values.sources.torch.policy?.nested.levels.push(3);
        first.values.sources.torch.policy?.nested.timestamp.setUTCFullYear(2000);

        expect(readConfig(schema, { sources: { torch: {} } }).values.sources.torch.policy).toEqual({
            nested: { levels: [1, 2], timestamp: new Date('2025-01-02T03:04:05.000Z') },
        });
    });

    it('returns independent structured defaults for invalid and migrated values', () => {
        const schema = defineConfig('Demo', {
            settings: section({
                description: 'General settings.',
                fields: { policy: mutableValueField({ migrateFrom: ['legacy', 'policy'] }) },
            }),
        });

        for (const raw of [{ settings: { policy: 'invalid' } }, { legacy: { policy: 'invalid' } }]) {
            const first = readConfig(schema, raw);
            first.values.settings.policy?.nested.levels.push(3);
            first.values.settings.policy?.nested.timestamp.setUTCFullYear(2000);

            expect(readConfig(schema, raw).values.settings.policy).toEqual({
                nested: { levels: [1, 2], timestamp: new Date('2025-01-02T03:04:05.000Z') },
            });
        }
    });

    it('reads valid values', () => {
        const { values, issues } = readConfig(demo, {
            web: { enabled: false, port: 9000, base_url: 'https://x.test//', token: 't' },
            overrides: { 'a.txt': { order: 3 }, 'b.c.txt': { enabled: false } },
        });
        expect(issues).toEqual([]);
        expect(values).toEqual({
            web: { enabled: false, port: 9000, base_url: 'https://x.test', token: 't' },
            overrides: { 'a.txt': { order: 3 }, 'b.c.txt': { enabled: false } },
        });
    });

    it('keeps a table entry named __proto__ as an own key', () => {
        const { values } = readConfig(demo, parse('[overrides."__proto__"]\norder = 3'));

        expect(Object.hasOwn(values.overrides, '__proto__')).toBe(true);
        expect(Object.getOwnPropertyDescriptor(values.overrides, '__proto__')?.value).toEqual({ order: 3 });
        expect(Object.getPrototypeOf(values.overrides)).toBe(Object.prototype);
    });

    it('falls back to the default and says which one for invalid values', () => {
        const { values, issues } = readConfig(demo, {
            web: { enabled: 'yes', port: 70000, base_url: 'ftp://x', token: 5 },
        });
        expect(values.web).toEqual({ enabled: true, port: 8123, base_url: '' });
        expect(issues.filter((i) => i.kind === 'invalid').map((i) => i.message)).toEqual([
            'web.enabled must be true or false; using true',
            'web.port must be a whole number from 1 to 65535; using 8123',
            'web.base_url must be an http:// or https:// URL; using ""',
            'web.token must be a string; ignoring it',
        ]);
    });

    it('reports unknown settings and sections', () => {
        const { issues } = readConfig(demo, {
            web: { enabled: true, port: 1, base_url: '', prot: 2 },
            extra: {},
            overrides: { 'a.txt': { ordr: 1 } },
        });
        expect(issues.filter((i) => i.kind === 'unknown').map((i) => i.message)).toEqual([
            'unknown option web.prot',
            'unknown option overrides."a.txt".ordr',
            'unknown section [extra]',
        ]);
    });

    it('reports unknown keys that match Object prototype properties', () => {
        const { issues } = readConfig(demo, {
            web: { constructor: true, toString: true },
            constructor: {},
            toString: {},
        });

        expect(issues.filter((issue) => issue.kind === 'unknown').map((issue) => issue.path)).toEqual([
            'web.constructor',
            'web.toString',
            'constructor',
            'toString',
        ]);
    });

    it('rejects a section or entry that is not a table, keeping the rest', () => {
        const a = readConfig(demo, { web: 'oops', overrides: { 'a.txt': 1, 'b.txt': { order: 2 } } });
        expect(a.values.web).toEqual({ enabled: true, port: 8123, base_url: '' });
        expect(a.values.overrides).toEqual({ 'b.txt': { order: 2 } });
        expect(a.issues.filter((i) => i.kind === 'invalid').map((i) => i.message)).toEqual([
            '[web] must be a table; using the defaults',
            'overrides."a.txt" must be a table; ignoring it',
        ]);
    });

    it('drops an invalid optional setting instead of inventing a value', () => {
        const { values } = readConfig(demo, { overrides: { 'a.txt': { order: 'first', enabled: false } } });
        expect(values.overrides['a.txt']).toEqual({ enabled: false });
    });
});
