import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { createMutableValue, mutableValueField } from '../test/mutable-value.ts';
import { field, int, str } from './fields.ts';
import { readConfig } from './read.ts';
import { renderConfig } from './render.ts';
import { defaultValues, defineConfig, section, table } from './schema.ts';

describe(defaultValues.name, () => {
    it('includes initial table entries in a fresh configuration', () => {
        const schema = defineConfig('Demo', {
            sources: table({
                description: 'Configured sources.',
                entryName: 'source',
                exampleKey: 'torch',
                defaults: { torch: { level: 14 } },
                fields: { level: int({ description: 'Light level.', example: 14, min: 0, max: 15 }) },
            }),
        });

        expect(defaultValues(schema)).toEqual({ sources: { torch: { level: 14 } } });
    });

    it('fills defaults in seeded table entries and keeps fresh config round trips consistent', () => {
        const schema = defineConfig('Demo', {
            sources: table({
                description: 'Configured sources.',
                entryName: 'source',
                exampleKey: 'torch',
                defaults: { torch: {} },
                fields: {
                    level: int({ description: 'Light level.', default: 14, min: 0, max: 15 }),
                    note: str({ description: 'Optional note.' }),
                },
            }),
        });

        const values = defaultValues(schema);
        const freshText = renderConfig(schema, values);
        const roundTrip = readConfig(schema, parse(freshText));
        const partialEntry = readConfig(schema, parse('[sources."torch"]'));

        expect(values.sources.torch).toEqual({ level: 14 });
        expect(freshText).toContain('level = 14');
        expect(roundTrip.issues).toEqual([]);
        expect(roundTrip.values).toEqual(values);
        expect(Object.hasOwn(roundTrip.values.sources.torch, 'note')).toBe(false);
        expect(partialEntry.values.sources.torch).toEqual({ level: 14 });
    });

    it('does not reinsert seeded table entries when the entire table is omitted', () => {
        const schema = defineConfig('Demo', {
            sources: table({
                description: 'Configured sources.',
                entryName: 'source',
                exampleKey: 'torch',
                defaults: { torch: {} },
                fields: { level: int({ description: 'Light level.', default: 14, min: 0, max: 15 }) },
            }),
        });

        expect(readConfig(schema, {}).values.sources).toEqual({});
    });

    it('validates custom field defaults added to seeded table entries', () => {
        const invalidField = field<number>({
            type: 'integer',
            description: 'Light level.',
            default: 0,
            expected: 'a positive integer',
            example: 14,
            parse: (raw) => (typeof raw === 'number' && raw > 0 ? { ok: true, value: raw } : { ok: false }),
            format: String,
        });

        expect(() =>
            table({
                description: 'Configured sources.',
                entryName: 'source',
                exampleKey: 'torch',
                defaults: { torch: {} },
                fields: { level: invalidField },
            }),
        ).toThrow('table() default "torch" field "level" must be a positive integer');
    });

    it('round trips normalized section defaults through rendered TOML', () => {
        const schema = defineConfig('Demo', {
            web: section({
                description: 'Web settings.',
                fields: {
                    base_url: str({
                        description: 'Base URL.',
                        default: 'https://example.test///',
                        check: {
                            expected: 'an http URL',
                            test: (value) => value.startsWith('https://'),
                            normalize: (value) => value.replace(/\/+$/, ''),
                        },
                    }),
                },
            }),
        });

        const freshValues = defaultValues(schema);
        const roundTrip = readConfig(schema, parse(renderConfig(schema, freshValues)));

        expect(freshValues.web.base_url).toBe('https://example.test');
        expect(roundTrip.issues).toEqual([]);
        expect(roundTrip.values.web.base_url).toBe('https://example.test');
    });

    it('retains normalized values when validating table defaults', () => {
        const schema = defineConfig('Demo', {
            sources: table({
                description: 'Configured sources.',
                entryName: 'source',
                exampleKey: 'torch',
                defaults: { torch: { base_url: 'https://example.test///' } },
                fields: {
                    base_url: str({
                        description: 'Base URL.',
                        example: 'https://example.test/',
                        check: {
                            expected: 'an http URL',
                            test: (value) => value.startsWith('https://'),
                            normalize: (value) => value.replace(/\/+$/, ''),
                        },
                    }),
                },
            }),
        });

        const freshValues = defaultValues(schema);
        const roundTrip = readConfig(schema, parse(renderConfig(schema, freshValues)));

        expect(freshValues.sources.torch.base_url).toBe('https://example.test');
        expect(roundTrip.issues).toEqual([]);
        expect(roundTrip.values.sources.torch.base_url).toBe('https://example.test');
    });

    it('returns fresh table entry values on every call', () => {
        const schema = defineConfig('Demo', {
            sources: table({
                description: 'Configured sources.',
                entryName: 'source',
                exampleKey: 'torch',
                defaults: { torch: { level: 14 } },
                fields: { level: int({ description: 'Light level.', example: 14, min: 0, max: 15 }) },
            }),
        });

        const first = defaultValues(schema);
        first.sources.torch.level = 4;

        expect(defaultValues(schema)).toEqual({ sources: { torch: { level: 14 } } });
    });

    it('deeply copies structured field and table defaults on every call', () => {
        const schema = defineConfig('Demo', {
            settings: section({
                description: 'General settings.',
                fields: { policy: mutableValueField() },
            }),
            sources: table({
                description: 'Configured sources.',
                entryName: 'source',
                exampleKey: 'torch',
                defaults: { torch: { policy: createMutableValue() } },
                fields: { policy: mutableValueField() },
            }),
        });

        const first = defaultValues(schema);
        first.settings.policy?.nested.levels.push(3);
        first.settings.policy?.nested.timestamp.setUTCFullYear(2000);
        first.sources.torch.policy?.nested.levels.push(3);
        first.sources.torch.policy?.nested.timestamp.setUTCFullYear(2000);

        const second = defaultValues(schema);
        expect(second.settings.policy).toEqual({
            nested: { levels: [1, 2], timestamp: new Date('2025-01-02T03:04:05.000Z') },
        });
        expect(second.sources.torch.policy).toEqual({
            nested: { levels: [1, 2], timestamp: new Date('2025-01-02T03:04:05.000Z') },
        });
    });

    it('deeply copies nested values in initial table entries', () => {
        const schema = defineConfig('Demo', {
            sources: table({
                description: 'Configured sources.',
                entryName: 'source',
                exampleKey: 'torch',
                defaults: { torch: { policy: createMutableValue() } },
                fields: { policy: mutableValueField() },
            }),
        });

        const first = defaultValues(schema);
        first.sources.torch.policy?.nested.levels.push(3);
        first.sources.torch.policy?.nested.timestamp.setUTCFullYear(2000);

        expect(defaultValues(schema).sources.torch.policy).toEqual({
            nested: { levels: [1, 2], timestamp: new Date('2025-01-02T03:04:05.000Z') },
        });
    });

    it('rejects out-of-range table defaults during schema construction', () => {
        expect(() =>
            table({
                description: 'Configured sources.',
                entryName: 'source',
                exampleKey: 'torch',
                defaults: { torch: { level: 16 } },
                fields: { level: int({ description: 'Light level.', example: 14, min: 0, max: 15 }) },
            }),
        ).toThrow('table() default "torch" field "level" must be a whole number from 0 to 15');
    });

    it('rejects fractional table defaults during schema construction', () => {
        expect(() =>
            table({
                description: 'Configured sources.',
                entryName: 'source',
                exampleKey: 'torch',
                defaults: { torch: { level: 1.5 } },
                fields: { level: int({ description: 'Light level.', example: 1, min: 0, max: 15 }) },
            }),
        ).toThrow('table() default "torch" field "level" must be a whole number from 0 to 15');
    });

    it('rejects custom string defaults before config or README generation', () => {
        expect(() =>
            table({
                description: 'Configured sources.',
                entryName: 'source',
                exampleKey: 'torch',
                defaults: { torch: { material: 'INVALID' } },
                fields: {
                    material: str({
                        description: 'Material name.',
                        example: 'torch',
                        check: {
                            expected: 'a lowercase material name',
                            test: (value) => value === value.toLowerCase(),
                        },
                    }),
                },
            }),
        ).toThrow('table() default "torch" field "material" must be a lowercase material name');
    });
});

describe(table.name, () => {
    it('rejects undeclared fields in table defaults', () => {
        const entryDefaults = { level: 14, enabled: true };
        const defaults = { torch: entryDefaults };

        expect(() =>
            table({
                description: 'Configured sources.',
                entryName: 'source',
                exampleKey: 'torch',
                defaults,
                fields: { level: int({ description: 'Light level.', example: 14, min: 0, max: 15 }) },
            }),
        ).toThrow('table() default "torch" has unknown field "enabled"');
    });
});
