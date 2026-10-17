import { defaultValues } from '@pumpkin-plugins/config';
import { describe, expect, it } from 'vitest';
import { configInfo, configSchema, loadTabDisplayConfig, validateConfig } from './config.ts';

function memoryStore(initial?: string) {
    let contents = initial;
    return {
        read: () => contents,
        write: (text: string) => {
            contents = text;
        },
        value: () => contents,
    };
}

describe('tab display configuration', () => {
    it('creates a structured TOML configuration with supported Java defaults', () => {
        const store = memoryStore();
        const loaded = loadTabDisplayConfig(store);
        expect(loaded.config.general.version).toBe(1);
        expect(loaded.config.general.refresh_ticks).toBe(20);
        expect(loaded.config.header.lines[0]?.text).toContain('%player_name%');
        expect(loaded.config.sorting.rules).toEqual([]);
        expect(store.value()).toContain('text =');
    });

    it('documents arrays of inline tables with their structured type', () => {
        const structuredOptions = configInfo.options?.filter(({ key }) =>
            ['header.lines', 'footer.lines', 'sorting.rules'].includes(key),
        );
        expect(structuredOptions?.map(({ key, type }) => [key, type])).toEqual([
            ['header.lines', 'table[]'],
            ['footer.lines', 'table[]'],
            ['sorting.rules', 'table[]'],
        ]);
    });

    it('uses each template section default in its TOML line example', () => {
        const descriptions = new Map(configInfo.options?.map(({ key, description }) => [key, description]));
        expect(descriptions.get('header.lines')).toContain(
            'for example [{ text = "Welcome %player_name%", color = "#FFB347" }]',
        );
        expect(descriptions.get('footer.lines')).toContain(
            'for example [{ text = "%server_online% players online", color = "#AAAAAA" }]',
        );
    });

    it('rejects malformed structured arrays without rewriting the user file', () => {
        const initial = '[header]\nlines = [{ text = 7 }]\n';
        const store = memoryStore(initial);
        expect(() => loadTabDisplayConfig(store)).toThrow(/header\.lines/);
        expect(store.value()).toBe(initial);
    });

    it('reports unsupported objectives with their config paths', () => {
        const config = structuredClone(defaultValues(configSchema));
        config.objective.enabled = true;
        const result = validateConfig(config);
        expect(result.kind).toBe('invalid');
        if (result.kind === 'invalid')
            expect(result.issues).toContainEqual({
                path: 'objective.enabled',
                reason: expect.stringContaining('unsupported'),
            });
    });

    it('rejects duplicate sort keys and invalid styles before a config can be applied', () => {
        const config = structuredClone(defaultValues(configSchema));
        config.header.lines = [{ text: 'Hi', color: 'red' }];
        config.sorting.rules = [
            { kind: 'name', direction: 'ascending' },
            { kind: 'name', direction: 'descending' },
        ];
        const result = validateConfig(config);
        expect(result.kind).toBe('invalid');
        if (result.kind === 'invalid') {
            expect(result.issues.map(({ path }) => path)).toEqual(
                expect.arrayContaining(['header.lines[0].color', 'sorting.rules']),
            );
        }
    });
});
