import { defaultValues, loadConfig } from '@pumpkin-plugins/config';
import { describe, expect, it } from 'vitest';
import { CONFIG_RENDER_OPTIONS, configInfo, configSchema } from './schema.ts';

class MemoryStore {
    text: string | undefined;
    read = () => this.text;
    write = (text: string) => {
        this.text = text;
    };
}

describe('configSchema', () => {
    it('has the defaults the documentation promises', () => {
        expect(defaultValues(configSchema)).toEqual({
            web: {
                enabled: true,
                bind: '0.0.0.0',
                port: 8123,
                public_url: '',
                port_forwarding: true
            },
            packs: { directory: 'packs', force: false },
            overrides: {}
        });
    });

    it('creates a config file that loads back unchanged', () => {
        const store = new MemoryStore();
        expect(loadConfig(configSchema, store, CONFIG_RENDER_OPTIONS).status).toBe('created');
        expect(store.text).toContain('/baddon reload');
        const again = loadConfig(configSchema, store, CONFIG_RENDER_OPTIONS);
        expect(again).toMatchObject({ status: 'unchanged', warnings: [] });
    });

    it('keeps user values and upgrades a file written by an older version of the plugin', () => {
        const store = new MemoryStore();
        store.text = '[web]\nport = 9000\nlegacy_option = true\n\n[overrides."a.mcpack"]\norder = 2\n';
        const result = loadConfig(configSchema, store, CONFIG_RENDER_OPTIONS);
        expect(result.status).toBe('updated');
        expect(result.removed).toEqual(['web.legacy_option']);
        expect(result.values.web.port).toBe(9000);
        expect(result.values.overrides['a.mcpack']).toEqual({ order: 2 });
        expect(store.text).toContain('public_url = ""');
        expect(store.text).not.toContain('legacy_option');
    });

    it('describes every setting in the README info, including the per-pack ones', () => {
        const keys = configInfo.options?.map((o) => o.key);
        expect(keys).toContain('web.public_url');
        expect(keys).toContain('overrides."<file>".download_url');
        expect(configInfo.defaultContents).toContain('[web]');
        expect(configInfo.file).toBe('config.toml');
    });
});
