import { describe, expect, it } from 'vitest';
import { makeMcpack, manifestJson } from './fixtures.ts';
import { pluginServers, portConfig } from './running.ts';

const start = pluginServers();

describe('commands', () => {
    it('lists the packs and reloads', async () => {
        const r = await start({
            name: 'commands',
            config: (port) => portConfig(port),
            files: { 'packs/a.mcpack': makeMcpack() }
        });
        await r.server.waitForLog(/Found 1 Bedrock pack/);

        const from = r.server.lines.length;
        r.server.command('baddon list');
        await r.server.waitForLog(/Bedrock packs \(1\)/, 10_000, from);
        await r.server.waitForLog(/a\.mcpack: 627409cd-5207-46f1-b1e8-0d4492616419 v1\.0\.1/, 10_000, from);

        r.put('packs/b.mcpack', makeMcpack(manifestJson({ uuid: '33333333-3333-4333-8333-333333333333' })));
        r.server.command('baddon reload');
        await r.server.waitForLog(/Reloaded the config and rescanned the packs folder: 2 packs listed/, 10_000, from);
        expect(r.server.errors()).toEqual([]);
    });
});
