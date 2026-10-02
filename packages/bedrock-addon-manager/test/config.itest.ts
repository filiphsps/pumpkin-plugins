import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { PLUGIN_NAME, pluginServers, portConfig } from './running.ts';

const start = pluginServers();

describe('first start', () => {
    it('creates the config and the packs folder, touches nothing else, and loads without errors', async () => {
        const r = await start({ name: 'first-start' });
        await r.server.waitForLog(/Created config\.toml with the default settings/);
        await r.server.waitForLog(/No packs in packs\//);
        await r.server.waitForLog(/Offering 0 Bedrock packs to players/);

        const config = r.read('config.toml');
        expect(config).toContain('[web]');
        expect(config).toContain('[packs]');
        expect(config).toContain('Changes apply after `/baddon reload`');
        expect(fs.statSync(path.join(r.data, 'packs')).isDirectory()).toBe(true);
        expect(fs.existsSync(path.join(r.data, 'resource-pack.generated.toml'))).toBe(false);
        expect(fs.existsSync(path.join(r.data, 'config.toml.tmp'))).toBe(false);
        await r.server.waitForLog(new RegExp(`Loaded ${PLUGIN_NAME}`));
    });
});

describe('config upgrades', () => {
    it('adds new settings, drops removed ones and keeps the admin values', async () => {
        const r = await start({
            name: 'upgrade',
            config: (port) => `${portConfig(port)}legacy_option = true\n\n[packs]\nforce = true\n`
        });
        const line = await r.server.waitForLog(/Updated config\.toml/);
        expect(line).toMatch(/added .*web\.enabled/);

        const config = parse(r.read('config.toml')) as { web: Record<string, unknown>; packs: Record<string, unknown> };
        expect(config.packs.force).toBe(true);
        expect(config.web.port).toBeGreaterThan(0);
        expect(config.web.enabled).toBe(true);
        expect(r.read('config.toml')).not.toContain('legacy_option');
        expect(fs.existsSync(path.join(r.data, 'config.toml.tmp'))).toBe(false);
    });

    it('leaves a config with an invalid value untouched and runs on the defaults', async () => {
        const text = '[web]\nport = "eighty"\n';
        const r = await start({ name: 'invalid-config', config: () => text });
        await r.server.waitForLog(/web\.port must be a whole number from 1 to 65535; using 8123/);
        await r.server.waitForLog(/config\.toml has invalid values, so it was left as it is/);
        expect(r.read('config.toml')).toBe(text);
    });
});
