import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import { routerConfig, upnpServers } from './running.ts';

const { router: startRouter, start } = upnpServers();

// A machine with a public address needs no mapping, which is the right behavior but not what these tests check.
const hasPublicAddress = Object.values(os.networkInterfaces())
    .flat()
    .some(
        (i) =>
            i?.family === 'IPv4' &&
            !i.internal &&
            !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.)/.test(
                i.address
            )
    );

describe.skipIf(hasPublicAddress)('port forwarding', () => {
    it('opens the Java and Bedrock ports through UPnP and closes them when the server stops', async () => {
        const router = await startRouter({ natPmp: false });
        const server = await start('upnp', routerConfig(router));
        await server.waitForLog(/Opened TCP port 25565 as 93\.184\.216\.34:25565 \(upnp\)/);
        await server.waitForLog(/Opened UDP port 19132 as 93\.184\.216\.34:19132 \(upnp\)/);

        expect([...router.igd.mappings.keys()].sort()).toEqual(['tcp:25565', 'udp:19132']);
        expect(router.igd.mappings.get('tcp:25565')).toMatchObject({
            internalPort: 25565,
            description: 'Pumpkin Java Edition',
            leaseSeconds: 3600
        });

        const from = server.lines.length;
        server.command('upnp status');
        await server.waitForLog(/Router: upnp at 127\.0\.0\.1, public address 93\.184\.216\.34\./, 10_000, from);
        await server.waitForLog(/java \(TCP 25565\): open at 93\.184\.216\.34:25565 \(upnp\)/, 10_000, from);
        expect(server.errors()).toEqual([]);

        await server.stop();
        expect([...router.igd.mappings.keys()]).toEqual([]);
    });

    it('uses NAT-PMP when the router has no UPnP', async () => {
        const router = await startRouter({ upnp: false });
        const server = await start('natpmp', routerConfig(router, '\n[bedrock]\nenabled = false\n'));
        await server.waitForLog(/Opened TCP port 25565 as 93\.184\.216\.34:\d+ \(nat-pmp\)/);
        expect([...router.igd.mappings.values()].map((m) => `${m.protocol}:${m.internalPort}`)).toEqual(['tcp:25565']);
        expect(server.errors()).toEqual([]);
    });

    it('says so when no router answers, and keeps running', async () => {
        const server = await start(
            'no-router',
            '[router]\nupnp_search = "127.0.0.1:9"\nnat_pmp_gateway = "127.0.0.1:9"\n'
        );
        await server.waitForLog(
            /No router could open ports: UPnP: no router answered the search; NAT-PMP: no answer from 127\.0\.0\.1\./,
            30_000
        );
        expect(server.errors()).toEqual([]);
    });

    it('opens the ports that changed on /upnp reload', async () => {
        const router = await startRouter({ natPmp: false });
        const server = await start('reload', routerConfig(router, '\n[bedrock]\nenabled = false\n'));
        await server.waitForLog(/Opened TCP port 25565/);
        server.command('upnp reload');
        await server.waitForLog(/Reloaded the config\. 1 port is being kept open\./);
        expect([...router.igd.mappings.keys()]).toEqual(['tcp:25565']);
    });
});
