import { MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { FakeIgd, FakeNetwork } from '@pumpkin-plugins/port-mapping/testing';
import {
    decodeReply,
    encodeRequest,
    type PortRequest,
    type Reply,
    type Request
} from '@pumpkin-plugins/upnpumpkin-api';
import { describe, expect, it } from 'vitest';
import { CONFIG_FILE } from './config/schema.ts';
import { PortForwarder } from './forwarder.ts';

function setup(config?: string, igd: FakeIgd | null = new FakeIgd()) {
    const files = new MemoryFiles();
    if (config) files.put(CONFIG_FILE, config);
    const log = new MemoryLogger();
    const net = new FakeNetwork(igd ? [igd] : []);
    const forwarder = new PortForwarder(files, log, net);
    /** Ticks with the clock moving until the predicate holds. */
    const settle = (until: () => boolean, limitMs = 60_000) => {
        for (const start = net.time; !until() && net.time - start < limitMs; net.time += 10) forwarder.tick();
        forwarder.tick();
    };
    const ask = (sender: string, request: Request): Reply => {
        const reply = decodeReply(forwarder.handleMessage(sender, encodeRequest(request)));
        if (!reply) throw new Error('no reply');
        return reply;
    };
    const keys = () => [...(igd?.mappings.keys() ?? [])].sort();
    return { files, log, net, igd: igd ?? undefined, forwarder, settle, ask, keys };
}

const web: PortRequest = { key: 'web', protocol: 'tcp', port: 8123, description: 'Packs' };
const ensure = (request: PortRequest = web): Request => ({ op: 'ensure', ...request });

describe('PortForwarder', () => {
    it('creates its config and opens the Java and Bedrock ports', () => {
        const { files, log, forwarder, settle, keys } = setup();
        forwarder.start();
        expect(files.text(CONFIG_FILE)).toContain('[java]');
        expect(log.of('info')).toContain('Created config.toml with the default settings.');

        settle(() => keys().length === 2);
        expect(keys()).toEqual(['tcp:25565', 'udp:19132']);
        expect(forwarder.snapshot.mappings.map((m) => m.key).sort()).toEqual(['own:bedrock', 'own:java']);
    });

    it('leaves out a port that is turned off, and uses the configured ports', () => {
        const { forwarder, settle, keys } = setup('[java]\nenabled = false\n\n[bedrock]\nport = 19133\n');
        forwarder.start();
        settle(() => keys().length === 1);
        expect(keys()).toEqual(['udp:19133']);
    });

    it('changes the ports on reload and closes the one that was turned off', () => {
        const { files, forwarder, settle, keys, net } = setup();
        forwarder.start();
        settle(() => keys().length === 2);
        const searches = net.sent.filter((s) => s.to.port === 1900).length;

        files.put(CONFIG_FILE, '[java]\nport = 25570\n\n[bedrock]\nenabled = false\n');
        forwarder.reload();
        settle(() => keys().join() === 'tcp:25570');
        expect(keys()).toEqual(['tcp:25570']);
        expect(net.sent.filter((s) => s.to.port === 1900)).toHaveLength(searches);
    });

    it('searches for the router again, and keeps what plugins asked for, when router settings change', () => {
        const { files, forwarder, settle, ask, keys, net } = setup(
            '[java]\nenabled = false\n\n[bedrock]\nenabled = false\n'
        );
        forwarder.start();
        ask('BedrockAddonManager', ensure());
        settle(() => keys().length === 1);
        const searches = net.sent.filter((s) => s.to.port === 1900).length;

        files.put(
            CONFIG_FILE,
            '[router]\nlease_seconds = 600\n\n[java]\nenabled = false\n\n[bedrock]\nenabled = false\n'
        );
        forwarder.reload();
        settle(() => net.sent.filter((s) => s.to.port === 1900).length > searches && keys().length === 1);
        expect(keys()).toEqual(['tcp:8123']);
        expect(ask('BedrockAddonManager', { op: 'status', key: 'web' })).toMatchObject({
            ok: true,
            status: { kind: 'open' }
        });
    });

    describe('requests from other plugins', () => {
        it('opens a port and reports where it is reachable', () => {
            const { forwarder, settle, ask, keys, log } = setup(
                '[java]\nenabled = false\n\n[bedrock]\nenabled = false\n'
            );
            forwarder.start();
            expect(ask('BedrockAddonManager', ensure())).toEqual({ ok: true, status: { kind: 'pending' } });
            settle(() => keys().length === 1);

            expect(ask('BedrockAddonManager', ensure())).toEqual({
                ok: true,
                status: { kind: 'open', via: 'upnp', address: '93.184.216.34', port: 8123 }
            });
            expect(keys()).toEqual(['tcp:8123']);
            expect(log.of('info')).toContain('BedrockAddonManager asked for TCP port 8123 to be opened (Packs).');
        });

        it("keeps each plugin's keys apart", () => {
            const { forwarder, settle, ask, keys } = setup('[java]\nenabled = false\n\n[bedrock]\nenabled = false\n');
            forwarder.start();
            ask('A', ensure({ ...web, port: 1111 }));
            ask('B', ensure({ ...web, port: 2222 }));
            settle(() => keys().length === 2);
            expect(keys()).toEqual(['tcp:1111', 'tcp:2222']);
            ask('A', { op: 'release', key: 'web' });
            settle(() => keys().length === 1);
            expect(keys()).toEqual(['tcp:2222']);
            expect(ask('A', { op: 'status', key: 'web' })).toEqual({ ok: true, status: { kind: 'unknown' } });
        });

        it('reports the network', () => {
            const { forwarder, settle, ask, keys } = setup();
            forwarder.start();
            settle(() => keys().length === 2);
            expect(ask('X', { op: 'info' })).toEqual({
                ok: true,
                info: {
                    localAddress: '192.168.1.50',
                    gateway: { kind: 'upnp', address: '192.168.1.1' },
                    externalAddress: '93.184.216.34'
                }
            });
        });

        it('reports a machine that is already public without opening anything', () => {
            const { forwarder, net, settle, ask } = setup(
                '[java]\nenabled = false\n\n[bedrock]\nenabled = false\n',
                null
            );
            net.local = [93, 184, 216, 99];
            forwarder.start();
            ask('X', ensure());
            settle(() => false, 200);
            expect(ask('X', ensure())).toEqual({
                ok: true,
                status: { kind: 'open', via: 'public', address: '93.184.216.99', port: 8123 }
            });
        });

        it('answers bad messages with an error instead of throwing', () => {
            const { forwarder } = setup();
            forwarder.start();
            const reply = decodeReply(forwarder.handleMessage('X', new TextEncoder().encode('nonsense')));
            expect(reply).toEqual({ ok: false, error: 'the message is not JSON' });
            const port = decodeReply(
                forwarder.handleMessage(
                    'X',
                    new TextEncoder().encode(
                        '{"v":1,"op":"ensure","key":"a","protocol":"tcp","port":0,"description":"d"}'
                    )
                )
            );
            expect(port).toMatchObject({ ok: false });
        });

        it('refuses them when turned off in the config', () => {
            const { forwarder, ask } = setup('[plugins]\nallow_requests = false\n');
            forwarder.start();
            expect(ask('X', ensure())).toEqual({ ok: false, error: expect.stringContaining('plugins.allow_requests') });
        });

        it('refuses them before it has started', () => {
            const { forwarder, ask } = setup();
            expect(ask('X', ensure())).toEqual({ ok: false, error: 'UPnPumpkin is not ready yet' });
            expect(forwarder.snapshot.mappings).toEqual([]);
        });

        it('limits how many ports plugins may hold, but lets known ones through', () => {
            const { forwarder, ask } = setup('[java]\nenabled = false\n\n[bedrock]\nenabled = false\n');
            forwarder.start();
            for (let i = 1; i <= 16; i++)
                expect(ask('X', ensure({ ...web, key: `k${i}`, port: 1000 + i }))).toMatchObject({ ok: true });
            expect(ask('X', ensure({ ...web, key: 'k17', port: 2000 }))).toEqual({
                ok: false,
                error: expect.stringContaining('at most 16')
            });
            expect(ask('X', ensure({ ...web, key: 'k1', port: 1001 }))).toMatchObject({ ok: true });
        });

        it('closes ports nobody has asked about for a while, and keeps those that are re-asked', () => {
            const { forwarder, settle, ask, keys, net, log } = setup(
                '[java]\nenabled = false\n\n[bedrock]\nenabled = false\n'
            );
            forwarder.start();
            ask('Gone', ensure({ ...web, key: 'a', port: 1111 }));
            ask('Alive', ensure({ ...web, key: 'b', port: 2222 }));
            settle(() => keys().length === 2);

            for (let minute = 0; minute < 6; minute++) {
                net.time += 60_000;
                ask('Alive', ensure({ ...web, key: 'b', port: 2222 }));
                forwarder.tick();
            }
            settle(() => keys().length === 1);
            expect(keys()).toEqual(['tcp:2222']);
            expect(log.of('info')).toContain('Gone stopped asking, so its port was closed.');
        });
    });

    it('closes every port on the router when stopped', () => {
        const { forwarder, settle, keys, net, ask } = setup();
        forwarder.start();
        ask('X', ensure());
        settle(() => keys().length === 3);
        net.autoAdvanceMs = 1;
        forwarder.stop();
        expect(keys()).toEqual([]);
        expect(net.leaks).toBe(0);
    });

    it('stops without a router and without having started', () => {
        const { forwarder, net } = setup(undefined, null);
        net.autoAdvanceMs = 1;
        expect(() => forwarder.stop()).not.toThrow();
        forwarder.start();
        expect(() => forwarder.stop()).not.toThrow();
        expect(() => forwarder.tick()).not.toThrow();
    });

    it('refuses to hand out settings before it was started', () => {
        expect(() => setup().forwarder.config).toThrow('has not been started');
    });
});

describe('PortForwarder with a blocked router', () => {
    const speedport = {
        '/html/login/index.html': { body: '<html><head><title>Speedport Konfigurationsprogramm</title></head>' }
    };
    const telekom = () => new FakeIgd({ upnp: false, natPmp: false, webPages: speedport });

    it('warns once when it starts, opens nothing and sends the router nothing', () => {
        const { log, net, forwarder, settle } = setup(undefined, telekom());
        forwarder.start();
        settle(() => forwarder.refusal !== undefined);
        settle(() => false, 60 * 60_000);

        expect(log.of('warn')).toHaveLength(1);
        expect(log.of('warn')[0]).toContain('UPnPumpkin is disabled: Telekom Speedport');
        expect(forwarder.refusal?.identity).toMatchObject({ manufacturer: 'Telekom' });
        expect(net.sent).toHaveLength(0);
        expect(forwarder.snapshot.mappings.every((m) => m.state.kind === 'failed')).toBe(true);
    });

    it('keeps the refusal across a reload and warns again only when router settings changed', () => {
        const { files, log, forwarder, settle } = setup(undefined, telekom());
        forwarder.start();
        settle(() => forwarder.refusal !== undefined);

        forwarder.reload();
        expect(forwarder.refusal).toBeDefined();
        expect(log.of('warn')).toHaveLength(1);

        files.put(CONFIG_FILE, '[router]\nlease_seconds = 600\n');
        forwarder.reload();
        expect(forwarder.refusal).toBeUndefined();
        settle(() => forwarder.refusal !== undefined);
        expect(log.of('warn')).toHaveLength(2);
    });

    it('tells other plugins why their port is not opened', () => {
        const { forwarder, settle, ask } = setup(undefined, telekom());
        forwarder.start();
        settle(() => forwarder.refusal !== undefined);
        const reply = ask('Other', ensure());
        expect(reply).toMatchObject({ ok: true, status: { kind: 'failed' } });
        expect(JSON.stringify(reply)).toContain('Telekom Speedport cannot be used');
    });
});
