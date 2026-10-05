import { describe, expect, it } from 'vitest';
import { int } from './fields.ts';
import { defaultValues, defineConfig, table } from './schema.ts';

describe(defaultValues.name, () => {
    it('includes initial table entries in a fresh configuration', () => {
        const schema = defineConfig('Demo', {
            sources: table({
                description: 'Configured sources.',
                entryName: 'source',
                exampleKey: 'torch',
                defaults: { torch: { level: 14 } },
                fields: { level: int({ description: 'Light level.', example: 14, min: 0, max: 15 }) }
            })
        });

        expect(defaultValues(schema)).toEqual({ sources: { torch: { level: 14 } } });
    });
});
