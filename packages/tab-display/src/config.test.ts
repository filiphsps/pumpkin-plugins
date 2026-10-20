import { describe, expect, it } from 'vitest';
import { configInfo, loadTabDisplayConfig } from './config.ts';

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
        expect(store.value()).toContain('text =');
    });

    it('documents arrays of inline tables with their structured type', () => {
        const structuredOptions = configInfo.options?.filter(({ key }) =>
            ['header.lines', 'footer.lines'].includes(key),
        );
        expect(structuredOptions?.map(({ key, type }) => [key, type])).toEqual([
            ['header.lines', 'table[]'],
            ['footer.lines', 'table[]'],
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

    it('reports malformed structured arrays without rewriting the user file', () => {
        const initial = '[header]\nlines = [{ text = 7 }]\n';
        const store = memoryStore(initial);
        expect(loadTabDisplayConfig(store).warnings.join('\n')).toMatch(/header\.lines/);
        expect(store.value()).toBe(initial);
    });

    it('falls back to the default for each invalid setting and keeps the valid ones', () => {
        const initial = [
            '[general]',
            'refresh_ticks = 5',
            '[placeholders]',
            'missing_provider = "blank"',
            '[header]',
            'lines = [{ text = "Hi", color = "red" }]',
            '[entry]',
            'text = "%player_name%"',
            'color = "#12345"',
            '',
        ].join('\n');
        const store = memoryStore(initial);

        const loaded = loadTabDisplayConfig(store);

        expect(loaded.config.general.refresh_ticks).toBe(5);
        expect(loaded.config.placeholders.missing_provider).toBe('literal');
        expect(loaded.config.header.lines[0]?.text).toBe('Welcome %player_name%');
        expect(loaded.config.entry.color).toBe('#FFFFFF');
        expect(loaded.warnings.join('\n')).toMatch(/placeholders\.missing_provider/);
        expect(loaded.warnings.join('\n')).toMatch(/header\.lines/);
        expect(loaded.warnings.join('\n')).toMatch(/entry\.color/);
        expect(store.value()).toBe(initial);
    });
});
