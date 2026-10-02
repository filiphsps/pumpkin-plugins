import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { makeMcpack, manifestJson, noise, SAMPLE_UUID } from './fixtures.ts';
import { pluginServers, portConfig } from './running.ts';

const start = pluginServers();

const bigPack = makeMcpack(manifestJson(), { files: { 'textures/big.bin': noise(2 * 1024 * 1024, 3) } });
const manifest = (uuid: string, modules: string[]) => strToU8(JSON.stringify(manifestJson({ uuid, modules })));

describe('pack discovery', () => {
    it('finds packs on start and the ones added later only on /baddon reload', async () => {
        const r = await start({ name: 'discover', config: (port) => portConfig(port) });
        await r.server.waitForLog(/No packs in packs\//);

        r.put('packs/late.mcpack', bigPack);
        await new Promise((resolve) => setTimeout(resolve, 2500));
        expect(r.server.lines.some((l) => l.includes('late.mcpack'))).toBe(false);

        const from = r.server.lines.length;
        r.server.command('baddon reload');
        await r.server.waitForLog(/Found 1 Bedrock pack: late\.mcpack/, 15_000, from);
        await r.server.waitForLog(/Offering 1 Bedrock pack to players/, 15_000, from);

        const res = await fetch(r.url('/packs/late.mcpack'));
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(bigPack);
    });

    it('warns about a broken pack and lists the good ones', async () => {
        const r = await start({
            name: 'broken',
            config: (port) => portConfig(port),
            files: { 'packs/good.mcpack': makeMcpack(), 'packs/bad.mcpack': 'not a zip' }
        });
        await r.server.waitForLog(/Found 1 Bedrock pack: good\.mcpack/);
        await r.server.waitForLog(/bad\.mcpack: not a valid zip archive/);
    });

    it('serves the resource pack of a .mcaddon and leaves out its behavior pack', async () => {
        const addon = zipSync({
            'RP/manifest.json': manifest(SAMPLE_UUID, ['resources']),
            'RP/textures/a.png': noise(4000, 5),
            'BP/manifest.json': manifest('33333333-3333-4333-8333-333333333333', ['data'])
        });
        const r = await start({
            name: 'mcaddon',
            config: (port) => portConfig(port),
            files: { 'packs/Cool Addon.mcaddon': addon }
        });
        await r.server.waitForLog(/Found 1 Bedrock pack: Cool Addon\.mcpack/);
        await r.server.waitForLog(/Cool Addon\.mcaddon: left out BP \(data, not a resource pack\)/);
        await r.server.waitForLog(/Offering 1 Bedrock pack to players/);

        const res = await fetch(r.url('/packs/Cool%20Addon.mcpack'));
        expect(res.status).toBe(200);
        const body = new Uint8Array(await res.arrayBuffer());
        expect(String.fromCharCode(...body.slice(0, 2))).toBe('PK');
        expect(r.server.errors()).toEqual([]);
    });
});
