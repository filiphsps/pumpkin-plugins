import { describe, expect, it } from 'vitest';
import { reloadLines, statusLines } from './format.ts';

const spec = { protocol: 'tcp', port: 25565, description: 'x' } as const;

describe('statusLines', () => {
    it('names the router and every port with where it is reachable', () => {
        const lines = statusLines(
            { gateway: { kind: 'upnp', address: [192, 168, 1, 1] }, externalAddress: [93, 184, 216, 34] },
            [
                {
                    key: 'own:java',
                    spec,
                    state: { kind: 'open', via: 'upnp', address: [93, 184, 216, 34], port: 25565 }
                },
                { key: 'plugin:BedrockAddonManager:web', spec: { ...spec, port: 8123 }, state: { kind: 'pending' } },
                {
                    key: 'own:bedrock',
                    spec: { ...spec, protocol: 'udp', port: 19132 },
                    state: { kind: 'failed', reason: 'no router answered the search' }
                }
            ]
        );
        expect(lines).toEqual([
            'Router: upnp at 192.168.1.1, public address 93.184.216.34.',
            'java (TCP 25565): open at 93.184.216.34:25565 (upnp)',
            'BedrockAddonManager web (TCP 8123): looking for a router',
            'bedrock (UDP 19132): not open: no router answered the search'
        ]);
    });

    it('says when nothing is found, with the local address when known, and when nothing was asked', () => {
        expect(statusLines({}, [])[0]).toBe('No router found yet.');
        expect(statusLines({ localAddress: [192, 168, 1, 5] }, [])[0]).toBe(
            "No router found yet. This machine's address is 192.168.1.5."
        );
        expect(statusLines({}, [])[1]).toContain('No ports were asked for');
    });

    it('explains a port that needs no mapping', () => {
        const [, line] = statusLines({}, [
            { key: 'own:java', spec, state: { kind: 'open', via: 'public', address: [1, 2, 3, 4], port: 25565 } }
        ]);
        expect(line).toBe('java (TCP 25565): reachable at 1.2.3.4:25565 (this machine has a public address)');
    });
});

describe('reloadLines', () => {
    it('counts the ports', () => {
        expect(reloadLines(1)).toEqual(['Reloaded the config. 1 port is being kept open.']);
        expect(reloadLines(3)).toEqual(['Reloaded the config. 3 ports are being kept open.']);
    });
});

describe('statusLines for a blocked router', () => {
    const identity = { manufacturer: 'Telekom', name: 'Speedport', source: 'web' } as const;
    const lines = statusLines({ identity, refused: { identity, reason: 'Telekom routers do not support UPnP' } }, [
        { key: 'own:java', spec, state: { kind: 'failed', reason: 'ignored' } }
    ]);

    it('opens with the reason as an error', () => {
        expect(lines[0]).toEqual({ text: expect.stringContaining('Telekom Speedport'), tone: 'error' });
        expect(lines.slice(1)).toEqual(['java (TCP 25565): not opened']);
    });
});

describe('statusLines with a router that is known', () => {
    it('names its make and model', () => {
        const [line] = statusLines(
            {
                gateway: { kind: 'upnp', address: [192, 168, 1, 1] },
                externalAddress: [93, 184, 216, 34],
                identity: { manufacturer: 'AVM', model: 'FRITZ!Box 7590', source: 'upnp' }
            },
            []
        );
        expect(line).toBe('Router: upnp at 192.168.1.1 (AVM FRITZ!Box 7590), public address 93.184.216.34.');
    });
});
