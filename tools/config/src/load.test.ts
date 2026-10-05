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

    it('seeds multiple new settings from one old value and then removes the old setting', () => {
        const schema = defineConfig('Demo', {
            web: section({
                description: 'The web server.',
                fields: {
                    memory_limit: int({
                        description: 'In-memory limit.',
                        default: 64,
                        min: 0,
                        migrateFrom: ['web', 'shared_limit']
                    }),
                    disk_limit: int({
                        description: 'Disk limit.',
                        default: 128,
                        min: 0,
                        migrateFrom: ['web', 'shared_limit']
                    })
                }
            })
        });
        const store = new MemoryStore('[web]\nshared_limit = 0\n');

        const result = loadConfig(schema, store);

        expect(result.status).toBe('updated');
        expect(result.values.web).toEqual({ memory_limit: 0, disk_limit: 0 });
        expect(result.added).toEqual(['web.memory_limit', 'web.disk_limit']);
        expect(result.removed).toEqual(['web.shared_limit']);
        expect(store.text).toContain('memory_limit = 0');
        expect(store.text).toContain('disk_limit = 0');
        expect(store.text).not.toContain('shared_limit');
    });

    it('uses defaults when no migration source exists and keeps explicitly configured new values', () => {
        const schema = defineConfig('Demo', {
            web: section({
                description: 'The web server.',
                fields: {
                    memory_limit: int({
                        description: 'In-memory limit.',
                        default: 64,
                        min: 0,
                        migrateFrom: ['web', 'shared_limit']
                    }),
                    disk_limit: int({
                        description: 'Disk limit.',
                        default: 128,
                        min: 0,
                        migrateFrom: ['web', 'shared_limit']
                    })
                }
            })
        });

        expect(loadConfig(schema, new MemoryStore('[web]\n')).values.web).toEqual({
            memory_limit: 64,
            disk_limit: 128
        });
        expect(loadConfig(schema, new MemoryStore('[web]\nshared_limit = 12\nmemory_limit = 24\n')).values.web).toEqual(
            { memory_limit: 24, disk_limit: 12 }
        );
    });

    it('does not rewrite a file when a migrated value is invalid for the new setting', () => {
        const schema = defineConfig('Demo', {
            web: section({
                description: 'The web server.',
                fields: {
                    limit: int({
                        description: 'Limit.',
                        default: 64,
                        min: 1,
                        migrateFrom: ['web', 'old_limit']
                    })
                }
            })
        });
        const text = '[web]\nold_limit = 0\n';
        const store = new MemoryStore(text);

        const result = loadConfig(schema, store);

        expect(result.status).toBe('kept');
        expect(result.values.web.limit).toBe(64);
        expect(result.warnings).toEqual([
            'web.limit must be a whole number of at least 1; using 64',
            'unknown option web.old_limit'
        ]);
        expect(store.text).toBe(text);
        expect(store.writes).toBe(0);
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

    it('keeps valid TOML integers beyond the JavaScript safe range for field validation', () => {
        const text = '[web]\nport = 9007199254740992\n';
        const store = new MemoryStore(text);

        const result = loadConfig(demo, store);

        expect(result.status).toBe('kept');
        expect(result.values.web.port).toBe(8123);
        expect(result.warnings[0]).toContain('web.port must be a whole number from 1 to 65535');
        expect(store.text).toBe(text);
        expect(store.writes).toBe(0);
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
