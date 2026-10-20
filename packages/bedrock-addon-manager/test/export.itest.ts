import * as fs from 'node:fs';
import * as path from 'node:path';
import { builtPluginPath, startPumpkin } from '@pumpkin-plugins/test-harness';
import { parse } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { makeMcpack, manifestJson, SAMPLE_UUID } from './fixtures.ts';
import { pluginServers, portConfig } from './running.ts';

const start = pluginServers();
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop()));
});

const OTHER_UUID = '22222222-2222-4222-8222-222222222222';

describe('/baddon export', () => {
    it('prints a pumpkin.toml block with exact sizes and the overrides, which Pumpkin then loads', async () => {
        const a = makeMcpack(manifestJson({ uuid: SAMPLE_UUID, modules: ['resources'], capabilities: ['raytraced'] }));
        const b = makeMcpack(manifestJson({ uuid: OTHER_UUID, version: [3, 1, 4] }));
        const r = await start({
            name: 'export',
            config: (port) =>
                portConfig(
                    port,
                    '\n[packs]\nforce = true\n\n[overrides."a.mcpack"]\norder = 1\nsub_pack_name = "hd"\ncontent_id = "id-1"\n',
                ),
            files: { 'packs/a.mcpack': a, 'packs/b.mcpack': b },
        });
        await r.server.waitForLog(/run \/baddon export on the server console/);

        const from = r.server.lines.length;
        r.server.command('baddon export');
        await r.server.waitForLog(/^content_id = "id-1"$/, 10_000, from);
        const lines = r.server.lines.slice(from);
        const block = lines.slice(lines.indexOf('[resource_pack.bedrock]'), lines.indexOf('content_id = "id-1"') + 1);
        const exported = parse(block.join('\n'));

        expect(exported).toMatchObject({
            resource_pack: {
                bedrock: {
                    enabled: true,
                    force: true,
                    packs: [
                        { uuid: OTHER_UUID, version: '3.1.4', size: b.length, download_url: r.url('/packs/b.mcpack') },
                        {
                            uuid: SAMPLE_UUID,
                            size: a.length,
                            download_url: r.url('/packs/a.mcpack'),
                            rtx_enabled: true,
                            sub_pack_name: 'hd',
                            content_id: 'id-1',
                        },
                    ],
                },
            },
        });
        // The operator pastes the block; the plugin never edits pumpkin.toml itself.
        expect(fs.readFileSync(path.join(r.server.dir, 'pumpkin.toml'), 'utf8')).not.toContain(SAMPLE_UUID);

        const pasted = await startPumpkin({
            name: 'export-pasted',
            plugins: [builtPluginPath(process.cwd())],
            config: exported,
        });
        stops.push(() => pasted.stop());
        // Pumpkin falls back to its defaults when the config does not deserialize, and then rewrites
        // pumpkin.toml from what it loaded. Its own serialization adds the optional fields we left out.
        const loaded = parse(fs.readFileSync(path.join(pasted.dir, 'pumpkin.toml'), 'utf8'));
        expect(loaded).toMatchObject({
            resource_pack: {
                bedrock: {
                    enabled: true,
                    packs: [
                        { uuid: OTHER_UUID, content_key: '' },
                        { uuid: SAMPLE_UUID, sub_pack_name: 'hd' },
                    ],
                },
            },
        });
        expect(pasted.errors()).toEqual([]);
        expect(r.server.errors()).toEqual([]);
    });
});
