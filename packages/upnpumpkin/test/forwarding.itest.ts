import * as dgram from 'node:dgram';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isPublicIpv4, parseIpv4 } from '@pumpkin-plugins/port-mapping/ipv4';
import { describe, expect, it } from 'vitest';
import { PLUGIN_NAME, routerConfig, upnpServers } from './running.ts';

const { router: startRouter, start } = upnpServers();

/** The address this machine uses toward the internet, found the way the plugin finds it. No packet is sent. */
async function defaultRouteAddress(): Promise<string | undefined> {
    const socket = dgram.createSocket('udp4');
    try {
        await new Promise<void>((resolve, reject) => {
            socket.once('error', reject);
            socket.connect(9, '8.8.8.8', resolve);
        });
        return socket.address().address;
    } catch {
        return undefined;
    } finally {
        socket.close();
    }
}

// A machine with a public address needs no mapping, which is the right behavior but not what these tests check.
const local = parseIpv4((await defaultRouteAddress()) ?? '');
const hasPublicAddress = local !== undefined && isPublicIpv4(local);

describe.skipIf(hasPublicAddress)('port forwarding', () => {
    it('opens the Java and Bedrock ports through UPnP and closes them when the server stops', async () => {
        const router = await startRouter({ natPmp: false });
        const server = await start('upnp', routerConfig(router));
        await server.waitForLog(
            new RegExp(`${PLUGIN_NAME}: Opened TCP port 25565 as 93\\.184\\.216\\.34:25565 \\(upnp\\)`),
        );
        await server.waitForLog(/Opened UDP port 19132 as 93\.184\.216\.34:19132 \(upnp\)/);
        await server.waitForLog(/Opened TCP port 19132 as 93\.184\.216\.34:19132 \(upnp\)/);

        expect([...router.igd.mappings.keys()].sort()).toEqual(['tcp:19132', 'tcp:25565', 'udp:19132']);
        expect(router.igd.mappings.get('tcp:25565')).toMatchObject({
            internalPort: 25565,
            description: 'Pumpkin Java Edition',
            leaseSeconds: 3600,
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
            '[router]\nupnp_search = "127.0.0.1:9"\nnat_pmp_gateway = "127.0.0.1:9"\n',
        );
        await server.waitForLog(
            /No router could open ports: UPnP: no router answered the search; NAT-PMP: no answer from 127\.0\.0\.1\./,
            30_000,
        );
        expect(server.errors()).toEqual([]);
    });

    it('retires the old router mapper and opens changed ports on /upnp reload', async () => {
        const router = await startRouter({ natPmp: false });
        const server = await start('reload', routerConfig(router, '\n[bedrock]\nenabled = false\n'));
        await server.waitForLog(/Opened TCP port 25565/);
        await fs.writeFile(
            path.join(server.pluginDataDir(PLUGIN_NAME), 'config.toml'),
            routerConfig(router, '\nnat_pmp = false\n[java]\nport = 25570\n[bedrock]\nenabled = false\n'),
        );
        const from = server.lines.length;
        server.command('upnp reload');
        await server.waitForLog(
            /Reloaded the config\. 1 port requested; \/upnp status shows which are open\./,
            10_000,
            from,
        );
        await server.waitForLog(/Opened TCP port 25570/, 10_000, from);
        expect([...router.igd.mappings.keys()]).toEqual(['tcp:25570']);
        expect(router.igd.actions.filter((a) => a === 'DeletePortMapping')).toHaveLength(1);
        expect(server.errors()).toEqual([]);
    });
});
