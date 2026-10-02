import { describe, expect, it } from 'vitest';
import { demo, MemoryStore } from '../test/schema.ts';
import { bool, int, str } from './fields.ts';
import { ConfigSyntaxError, loadConfig } from './load.ts';
import { renderConfig } from './render.ts';
import { defaultValues, defineConfig, section } from './schema.ts';

describe('loadConfig', () => {
    it('creates the file with the defaults when it is missing', () => {
        const store = new MemoryStore();
        const result = loadConfig(demo, store);
        expect(result.status).toBe('created');
        expect(result.values).toEqual(defaultValues(demo));
        expect(store.text).toBe(renderConfig(demo, defaultValues(demo)));
    });

    it('leaves a file that already matches alone', () => {
        const store = new MemoryStore();
        loadConfig(demo, store);
        const result = loadConfig(demo, store);
        expect(result).toMatchObject({ status: 'unchanged', warnings: [], added: [], removed: [] });
        expect(store.writes).toBe(1);
    });

    it('adds new settings and drops removed ones in an existing file, keeping the user values', () => {
        const v1 = defineConfig('Demo', {
            web: section({
                description: 'The web server.',
                fields: {
                    enabled: bool({ description: 'Serve over HTTP.', default: true }),
                    port: int({ description: 'Port to listen on.', default: 8123 }),
                    legacy: str({ description: 'Going away.', default: 'old' })
                }
            })
        });
        const store = new MemoryStore(renderConfig(v1, { web: { enabled: false, port: 9000, legacy: 'mine' } }));

        const v2 = defineConfig('Demo', {
            web: section({
                description: 'The web server.',
                fields: {
                    enabled: bool({ description: 'Serve over HTTP.', default: true }),
                    port: int({ description: 'Port to listen on.', default: 8123 }),
                    bind: str({ description: 'Address to listen on.', default: '0.0.0.0' })
                }
            })
        });
        const result = loadConfig(v2, store);

        expect(result.status).toBe('updated');
        expect(result.added).toEqual(['web.bind']);
        expect(result.removed).toEqual(['web.legacy']);
        expect(result.values.web).toEqual({ enabled: false, port: 9000, bind: '0.0.0.0' });
        expect(store.text).toContain('enabled = false');
        expect(store.text).toContain('port = 9000');
        expect(store.text).toContain('bind = "0.0.0.0"');
        expect(store.text).not.toContain('legacy');
        expect(loadConfig(v2, store).status).toBe('unchanged');
    });

    it('normalizes a hand-written file but keeps its values', () => {
        const store = new MemoryStore('[web]\nport = 4000 # my comment\n');
        const result = loadConfig(demo, store);
        expect(result.status).toBe('updated');
        expect(result.added).toEqual(['web.enabled', 'web.base_url']);
        expect(result.values.web.port).toBe(4000);
        expect(store.text).toContain('port = 4000');
        expect(store.text).not.toContain('my comment');
    });

    it('keeps table entries the schema does not know about', () => {
        const store = new MemoryStore('[overrides."some.file.txt"]\norder = 4\n');
        loadConfig(demo, store);
        expect(store.text).toContain('[overrides."some.file.txt"]\norder = 4');
    });

    it('never rewrites a file with an invalid value, so nothing the user typed is lost', () => {
        const text = '[web]\nport = "eighty"\nprot = 1\n';
        const store = new MemoryStore(text);
        const result = loadConfig(demo, store);
        expect(result.status).toBe('kept');
        expect(result.values.web.port).toBe(8123);
        expect(result.warnings).toEqual([
            'web.port must be a whole number from 1 to 65535; using 8123',
            'unknown option web.prot'
        ]);
        expect(store.text).toBe(text);
        expect(store.writes).toBe(0);
    });

    it('throws on a syntax error and leaves the file alone', () => {
        const text = '[web\nport = 1';
        const store = new MemoryStore(text);
        expect(() => loadConfig(demo, store)).toThrow(ConfigSyntaxError);
        expect(() => loadConfig(demo, store)).toThrow(
            'Invalid TOML document: illegal character in key (line 1, column 5)'
        );
        expect(store.text).toBe(text);
        expect(store.writes).toBe(0);
    });
});
