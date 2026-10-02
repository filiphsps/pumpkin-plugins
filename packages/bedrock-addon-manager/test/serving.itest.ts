import * as net from 'node:net';
import { freePort } from '@pumpkin-plugins/test-harness';
import { describe, expect, it } from 'vitest';
import { makeMcpack, manifestJson, noise } from './fixtures.ts';
import { PLUGIN_NAME, pluginServers, portConfig } from './running.ts';

const start = pluginServers();

const bigPack = makeMcpack(manifestJson(), { files: { 'textures/big.bin': noise(2 * 1024 * 1024, 3) } });

describe('web server', () => {
    it('serves a pack with the right bytes and headers, and supports HEAD and ranges', async () => {
        const r = await start({
            name: 'serve',
            config: (port) => portConfig(port),
            files: { 'packs/My Pack.mcpack': bigPack }
        });
        await r.server.waitForLog(/Serving packs on/);

        const res = await fetch(r.url('/packs/My%20Pack.mcpack'));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/zip');
        expect(res.headers.get('content-length')).toBe(String(bigPack.length));
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(bigPack);

        const head = await fetch(r.url('/packs/My%20Pack.mcpack'), { method: 'HEAD' });
        expect(head.status).toBe(200);
        expect(head.headers.get('content-length')).toBe(String(bigPack.length));
        expect((await head.arrayBuffer()).byteLength).toBe(0);

        const part = await fetch(r.url('/packs/My%20Pack.mcpack'), { headers: { Range: 'bytes=1000-1999' } });
        expect(part.status).toBe(206);
        expect(part.headers.get('content-range')).toBe(`bytes 1000-1999/${bigPack.length}`);
        expect(new Uint8Array(await part.arrayBuffer())).toEqual(bigPack.subarray(1000, 2000));
        expect(r.server.errors()).toEqual([]);
    });

    it('answers 404 and 405 and never serves files outside the packs list', async () => {
        const r = await start({
            name: 'reject',
            config: (port) => portConfig(port, '[overrides."hidden.mcpack"]\nenabled = false\n'),
            files: {
                'packs/a.mcpack': makeMcpack(),
                'packs/hidden.mcpack': makeMcpack(manifestJson({ uuid: '11111111-1111-4111-8111-111111111111' })),
                'packs/notes.txt': 'secret'
            }
        });
        await r.server.waitForLog(/Serving packs on/);

        const status = async (urlPath: string, init?: RequestInit) => (await fetch(r.url(urlPath), init)).status;
        expect(await status('/packs/a.mcpack')).toBe(200);
        expect(await status('/packs/missing.mcpack')).toBe(404);
        expect(await status('/packs/hidden.mcpack')).toBe(404);
        expect(await status('/packs/notes.txt')).toBe(404);
        expect(await status('/packs/..%2Fconfig.toml')).toBe(404);
        expect(await status('/packs/%2e%2e%2fconfig.toml')).toBe(404);
        expect(await status('/config.toml')).toBe(404);
        expect(await status('/packs/a.mcpack', { method: 'POST' })).toBe(405);
    });

    it('serves several downloads at once', async () => {
        const r = await start({
            name: 'parallel',
            config: (port) => portConfig(port),
            files: { 'packs/a.mcpack': bigPack }
        });
        await r.server.waitForLog(/Serving packs on/);

        const results = await Promise.all(
            Array.from(
                { length: 12 },
                async () => new Uint8Array(await (await fetch(r.url('/packs/a.mcpack'))).arrayBuffer())
            )
        );
        for (const body of results) expect(body).toEqual(bigPack);
        expect(r.server.errors()).toEqual([]);
    });

    it('logs a port that is taken and keeps running', async () => {
        const taken = await freePort();
        const blocker = net.createServer();
        await new Promise<void>((resolve) => blocker.listen(taken, '0.0.0.0', resolve));
        try {
            const r = await start({ name: 'port-taken', config: () => portConfig(taken) });
            const line = await r.server.waitForLog(/Could not start the web server/);
            expect(line).toContain(`cannot listen on 0.0.0.0:${taken}: the port is already in use`);
            await r.server.waitForLog(new RegExp(`Loaded ${PLUGIN_NAME}`));
        } finally {
            blocker.close();
        }
    });
});
