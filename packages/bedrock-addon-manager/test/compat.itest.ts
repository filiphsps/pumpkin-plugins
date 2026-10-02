import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeMcpack, manifestJson, SAMPLE_UUID } from './fixtures.ts';
import { pluginServers, portConfig } from './running.ts';

const start = pluginServers();

describe('pumpkin.toml', () => {
    it('is never changed: the packs go to the server in memory', async () => {
        const r = await start({
            name: 'compat',
            config: (port) =>
                portConfig(
                    port,
                    '[overrides."a.mcpack"]\naddon_pack = true\nsub_pack_name = "hd"\ncontent_id = "id-1"\n'
                ),
            files: {
                'packs/a.mcpack': makeMcpack(
                    manifestJson({ uuid: SAMPLE_UUID, modules: ['resources'], capabilities: ['raytraced'] })
                ),
                'packs/b.mcpack': makeMcpack(
                    manifestJson({ uuid: '22222222-2222-4222-8222-222222222222', version: [3, 1, 4] })
                )
            }
        });
        await r.server.waitForLog(/Offering 2 Bedrock packs to players/);

        const toml = fs.readFileSync(path.join(r.server.dir, 'pumpkin.toml'), 'utf8');
        expect(toml).not.toContain(SAMPLE_UUID);
        expect(fs.existsSync(path.join(r.data, 'resource-pack.generated.toml'))).toBe(false);
        expect(r.server.errors()).toEqual([]);
    });

    it('lists packs that share a UUID only once', async () => {
        const r = await start({
            name: 'duplicates',
            config: (port) => portConfig(port),
            files: { 'packs/a.mcpack': makeMcpack(), 'packs/b.mcpack': makeMcpack() }
        });
        await r.server.waitForLog(/b\.mcpack has the same UUID as a\.mcpack; skipping it/);
        await r.server.waitForLog(/Offering 1 Bedrock pack to players/);
    });
});
