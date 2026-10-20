import { ansi } from '@pumpkin-plugins/minecraft-colors';
import { MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { delayReplies, FakeIgd, FakeNetwork } from '@pumpkin-plugins/port-mapping/testing';
import {
    decodeReply,
    encodeRequest,
    type PortRequest,
    type Reply,
    type Request,
} from '@pumpkin-plugins/upnpumpkin-api';
import { describe, expect, it } from 'vitest';
import { statusLines } from './commands/format.ts';
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
        expect(log.of('info')).toContain(`Created ${ansi.named.name('config.toml')} with the default settings.`);

        settle(() => keys().length === 3);
        expect(keys()).toEqual(['tcp:19132', 'tcp:25565', 'udp:19132']);
        expect(forwarder.snapshot.mappings.map((m) => m.key).sort()).toEqual([
            'own:bedrock',
            'own:bedrock-tcp',
            'own:java',
        ]);
    });

    it('leaves out a port that is turned off, and uses the configured ports', () => {
        const { forwarder, settle, keys } = setup('[java]\nenabled = false\n\n[bedrock]\nport = 19133\n');
        forwarder.start();
        settle(() => keys().length === 2);
        expect(keys()).toEqual(['tcp:19133', 'udp:19133']);
    });

    it('changes the ports on reload and closes the one that was turned off', () => {
        const { files, forwarder, settle, keys, net } = setup();
        forwarder.start();
        settle(() => keys().length === 3);
        const searches = net.sent.filter((s) => s.to.port === 1900).length;

        files.put(CONFIG_FILE, '[java]\nport = 25570\n\n[bedrock]\nenabled = false\n');
        forwarder.reload();
        settle(() => keys().join() === 'tcp:25570');
        expect(keys()).toEqual(['tcp:25570']);
        expect(net.sent.filter((s) => s.to.port === 1900)).toHaveLength(searches);
    });

    it('keeps the router and its ports when only the lease changes, and uses the new lease at renewal', () => {
        const { files, forwarder, settle, keys, net, igd } = setup('[bedrock]\nenabled = false\n');
        forwarder.start();
        settle(() => keys().length === 1);
        const searches = net.sent.filter((s) => s.to.port === 1900).length;

        files.put(CONFIG_FILE, '[router]\nlease_seconds = 600\n\n[bedrock]\nenabled = false\n');
        forwarder.reload();
        settle(() => igd?.mappings.get('tcp:25565')?.leaseSeconds === 600, 3600_000);
        expect(igd?.mappings.get('tcp:25565')?.leaseSeconds).toBe(600);
        expect(igd?.actions.filter((a) => a === 'DeletePortMapping')).toHaveLength(0);
        expect(net.sent.filter((s) => s.to.port === 1900)).toHaveLength(searches);
    });

    it('keeps the current settings and ports when a reload finds broken TOML', () => {
        const { files, forwarder, settle, keys, net } = setup('[java]\nport = 25570\n\n[bedrock]\nenabled = false\n');
        forwarder.start();
        settle(() => keys().length === 1);
        const searches = net.sent.filter((s) => s.to.port === 1900).length;

        files.put(CONFIG_FILE, '[java\nport = 25570\n');
        expect(() => forwarder.reload()).toThrow();
        settle(() => false, 1000);
        expect(forwarder.config.java.port).toBe(25570);
        expect(keys()).toEqual(['tcp:25570']);
        expect(net.sent.filter((s) => s.to.port === 1900)).toHaveLength(searches);
    });

    it('searches for the router again, and keeps what plugins asked for, when router settings change', () => {
        const { files, forwarder, settle, ask, keys, net } = setup(
            '[java]\nenabled = false\n\n[bedrock]\nenabled = false\n',
        );
        forwarder.start();
        ask('BedrockAddonManager', ensure());
        settle(() => keys().length === 1);
        const searches = net.sent.filter((s) => s.to.port === 1900).length;

        files.put(CONFIG_FILE, '[router]\nnat_pmp = false\n\n[java]\nenabled = false\n\n[bedrock]\nenabled = false\n');
        forwarder.reload();
        settle(() => net.sent.filter((s) => s.to.port === 1900).length > searches && keys().length === 1);
        expect(keys()).toEqual(['tcp:8123']);
        expect(ask('BedrockAddonManager', { op: 'status', key: 'web' })).toMatchObject({
            ok: true,
            status: { kind: 'open' },
        });
    });

    it('returns from router reload without polling cleanup and waits for it before replacement creation', () => {
        const { files, forwarder, settle, keys, net, igd } = setup(
            '[bedrock]\nenabled = false\n',
            new FakeIgd({ natPmp: false }),
        );
        forwarder.start();
        settle(() => keys().length === 1);
        const resume = delayReplies(net, 'DeletePortMapping');
        files.put(CONFIG_FILE, '[router]\nnat_pmp = false\n[java]\nport = 25570\n[bedrock]\nenabled = false\n');
        net.autoAdvanceMs = 1;
        const before = net.time;
        forwarder.reload();
        expect(net.time - before).toBeLessThan(50);
        expect(igd?.actions.filter((a) => a === 'DeletePortMapping')).toHaveLength(0);
        forwarder.tick();
        expect(igd?.actions.filter((a) => a === 'DeletePortMapping')).toHaveLength(1);
        expect(igd?.actions.filter((a) => a === 'AddPortMapping')).toHaveLength(1);
        resume();
        settle(() => keys().join() === 'tcp:25570');
        settle(() => forwarder.snapshot.mappings[0]?.state.kind === 'open');
        expect(keys()).toEqual(['tcp:25570']);
        expect(net.leaks).toBe(0);
    });

    it('bounds repeated reloads while one old mapper retires and applies the final configuration', () => {
        const { files, forwarder, settle, keys, net, igd } = setup(
            '[bedrock]\nenabled = false\n',
            new FakeIgd({ natPmp: false }),
        );
        forwarder.start();
        settle(() => keys().length === 1);
        const resume = delayReplies(net, 'DeletePortMapping');
        net.autoAdvanceMs = 1;
        const before = net.time;
        const connections = net.connections.length;
        for (let i = 0; i < 50; i++) {
            files.put(
                CONFIG_FILE,
                `[router]\nnat_pmp = ${i % 2 === 1}\n[java]\nport = ${26000 + i}\n[bedrock]\nenabled = false\n`,
            );
            forwarder.reload();
            forwarder.tick();
        }
        expect(net.time - before).toBeLessThan(500);
        expect(net.connections.length - connections).toBe(1);
        expect(igd?.actions.filter((a) => a === 'AddPortMapping')).toHaveLength(1);
        resume();
        settle(() => keys().join() === 'tcp:26049');
        settle(() => forwarder.snapshot.mappings[0]?.state.kind === 'open');
        expect(keys()).toEqual(['tcp:26049']);
        expect(net.leaks).toBe(0);
    });

    it('cancels stalled retirement at its tick deadline and allows the replacement to progress', () => {
        const { files, forwarder, settle, keys, net, log } = setup(
            '[bedrock]\nenabled = false\n',
            new FakeIgd({ natPmp: false }),
        );
        forwarder.start();
        settle(() => keys().length === 1);
        delayReplies(net, 'DeletePortMapping');
        net.autoAdvanceMs = 1;
        files.put(CONFIG_FILE, '[router]\nnat_pmp = false\n[java]\nport = 25570\n[bedrock]\nenabled = false\n');
        forwarder.reload();
        forwarder.tick();
        const cleanupConnection = net.connections.at(-1);
        expect(cleanupConnection?.closed).toBe(false);
        net.time += 3000;
        forwarder.tick();
        expect(cleanupConnection?.closed).toBe(true);
        expect(log.of('warn').some((m) => m.includes('cleanup did not finish'))).toBe(true);
        settle(() => keys().join() === 'tcp:25570');
        settle(() => forwarder.snapshot.mappings[0]?.state.kind === 'open');
        expect(net.leaks).toBe(0);
    });

    it('accounts for in-flight old creation before handing a reload to its replacement', () => {
        const { files, forwarder, settle, keys, net } = setup(
            '[bedrock]\nenabled = false\n',
            new FakeIgd({ natPmp: false }),
        );
        const resume = delayReplies(net, 'AddPortMapping');
        forwarder.start();
        settle(() => keys().length === 1);
        files.put(CONFIG_FILE, '[router]\nnat_pmp = false\n[java]\nport = 25570\n[bedrock]\nenabled = false\n');
        forwarder.reload();
        forwarder.tick();
        expect(keys()).toEqual(['tcp:25565']);
        resume();
        settle(() => keys().join() === 'tcp:25570');
        settle(() => forwarder.snapshot.mappings[0]?.state.kind === 'open');
        expect(keys()).toEqual(['tcp:25570']);
        expect(net.leaks).toBe(0);
    });

    it('stops a retiring mapper without starting its unpolled replacement', () => {
        const { files, forwarder, settle, keys, net, igd } = setup(
            '[bedrock]\nenabled = false\n',
            new FakeIgd({ natPmp: false }),
        );
        forwarder.start();
        settle(() => keys().length === 1);
        delayReplies(net, 'DeletePortMapping');
        files.put(CONFIG_FILE, '[router]\nnat_pmp = false\n[bedrock]\nenabled = false\n');
        forwarder.reload();
        forwarder.tick();
        net.autoAdvanceMs = 1;
        const before = net.time;
        forwarder.stop();
        expect(net.time - before).toBeLessThanOrEqual(3010);
        expect(net.leaks).toBe(0);
        expect(igd?.actions.filter((a) => a === 'AddPortMapping')).toHaveLength(1);
    });

    describe('requests from other plugins', () => {
        it('opens a port and reports where it is reachable', () => {
            const { forwarder, settle, ask, keys, log } = setup(
                '[java]\nenabled = false\n\n[bedrock]\nenabled = false\n',
            );
            forwarder.start();
            expect(ask('BedrockAddonManager', ensure())).toEqual({ ok: true, status: { kind: 'pending' } });
            settle(() => keys().length === 1);

            expect(ask('BedrockAddonManager', ensure())).toEqual({
                ok: true,
                status: { kind: 'open', via: 'upnp', address: '93.184.216.34', port: 8123 },
            });
            expect(keys()).toEqual(['tcp:8123']);
            expect(log.of('info')).toContain(
                `${ansi.named.name('BedrockAddonManager')} asked for TCP port ${ansi.named.port('8123')} to be opened (Packs).`,
            );
        });

        it("keeps each plugin's keys apart", () => {
            const { forwarder, settle, ask, keys } = setup(
                '[java]\nenabled = false\n\n[bedrock]\nenabled = false\n\n[plugins]\nallowed = ["A", "B"]\n',
            );
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

        it('keeps plugins apart when their names and keys contain colons', () => {
            const { forwarder, settle, ask, keys } = setup(
                '[java]\nenabled = false\n\n[bedrock]\nenabled = false\n\n[plugins]\nallowed = ["A", "A:B"]\n',
            );
            forwarder.start();
            ask('A', ensure({ ...web, key: 'B:web', port: 1111 }));
            ask('A:B', ensure({ ...web, key: 'web', port: 2222 }));
            settle(() => keys().length === 2);
            expect(keys()).toEqual(['tcp:1111', 'tcp:2222']);
            const lines = statusLines(forwarder.snapshot.info, forwarder.snapshot.mappings);
            expect(lines).toContainEqual(expect.stringMatching(/^A B:web \(TCP 1111\)/));
            expect(lines).toContainEqual(expect.stringMatching(/^A:B web \(TCP 2222\)/));
        });

        it('reports the network', () => {
            const { forwarder, settle, ask, keys } = setup();
            forwarder.start();
            settle(() => keys().length === 3);
            expect(ask('X', { op: 'info' })).toEqual({
                ok: true,
                info: {
                    localAddress: '192.168.1.50',
                    gateway: { kind: 'upnp', address: '192.168.1.1' },
                    externalAddress: '93.184.216.34',
                },
            });
        });

        it('reports a machine that is already public without opening anything', () => {
            const { forwarder, net, settle, ask } = setup(
                '[java]\nenabled = false\n\n[bedrock]\nenabled = false\n\n[plugins]\nallowed = ["X"]\n',
                null,
            );
            net.local = [93, 184, 216, 99];
            forwarder.start();
            ask('X', ensure());
            settle(() => false, 200);
            expect(ask('X', ensure())).toEqual({
                ok: true,
                status: { kind: 'open', via: 'public', address: '93.184.216.99', port: 8123 },
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
                        '{"v":1,"op":"ensure","key":"a","protocol":"tcp","port":0,"description":"d"}',
                    ),
                ),
            );
            expect(port).toMatchObject({ ok: false });
        });

        it('refuses new ports when turned off in the config, but still gives open ones back', () => {
            const { files, forwarder, settle, ask, keys } = setup(
                '[plugins]\nallow_requests = false\nallowed = ["X"]\n',
            );
            forwarder.start();
            expect(ask('X', ensure())).toEqual({ ok: false, error: expect.stringContaining('plugins.allow_requests') });

            files.put(CONFIG_FILE, '[plugins]\nallow_requests = true\nallowed = ["X"]\n');
            forwarder.reload();
            ask('X', ensure());
            settle(() => keys().includes('tcp:8123'));

            files.put(CONFIG_FILE, '[plugins]\nallow_requests = false\nallowed = ["X"]\n');
            forwarder.reload();
            expect(ask('X', { op: 'release', key: 'web' })).toEqual({ ok: true });
            settle(() => !keys().includes('tcp:8123'));
            expect(keys()).toEqual(['tcp:19132', 'tcp:25565', 'udp:19132']);
            expect(ask('X', { op: 'status', key: 'web' })).toEqual({ ok: true, status: { kind: 'unknown' } });
            expect(ask('X', { op: 'info' })).toMatchObject({ ok: true });
        });

        it('refuses ports to plugins missing from plugins.allowed and warns once about each', () => {
            const { files, forwarder, ask, log } = setup('[java]\nenabled = false\n\n[bedrock]\nenabled = false\n');
            forwarder.start();
            expect(ask('Stranger', ensure({ ...web, port: 22 }))).toEqual({
                ok: false,
                error: expect.stringContaining('plugins.allowed'),
            });
            ask('Stranger', ensure({ ...web, port: 22 }));
            expect(log.of('warn').filter((m) => m.includes('Stranger'))).toHaveLength(1);
            expect(log.of('warn').find((m) => m.includes('Stranger'))).toContain('22');
            expect(forwarder.snapshot.mappings).toEqual([]);
            expect(ask('BedrockAddonManager', ensure())).toMatchObject({ ok: true });

            files.put(
                CONFIG_FILE,
                '[java]\nenabled = false\n\n[bedrock]\nenabled = false\n\n[plugins]\nallowed = ["Stranger"]\n',
            );
            forwarder.reload();
            expect(ask('Stranger', ensure({ ...web, port: 22 }))).toMatchObject({ ok: true });
        });

        it('refuses them before it has started', () => {
            const { forwarder, ask } = setup();
            expect(ask('X', ensure())).toEqual({ ok: false, error: 'UPnPumpkin is not ready yet' });
            expect(forwarder.snapshot.mappings).toEqual([]);
        });

        it("limits each plugin without letting one plugin use another plugin's share", () => {
            const { forwarder, ask } = setup(
                '[java]\nenabled = false\n\n[bedrock]\nenabled = false\n\n[plugins]\nmax_requests_per_plugin = 2\nallowed = ["X", "Y"]\n',
            );
            forwarder.start();
            for (let i = 1; i <= 2; i++)
                expect(ask('X', ensure({ ...web, key: `k${i}`, port: 1000 + i }))).toMatchObject({ ok: true });
            expect(ask('Y', ensure({ ...web, key: 'k1', port: 2000 }))).toMatchObject({ ok: true });
            expect(ask('X', ensure({ ...web, key: 'k3', port: 1003 }))).toEqual({
                ok: false,
                error: expect.stringContaining('at most 2 ports can be requested per plugin'),
            });
            expect(ask('X', ensure({ ...web, key: 'k1', port: 1001 }))).toMatchObject({ ok: true });
        });

        it('closes ports nobody has asked about for a while, and keeps those that are re-asked', () => {
            const { forwarder, settle, ask, keys, net, log } = setup(
                '[java]\nenabled = false\n\n[bedrock]\nenabled = false\n\n[plugins]\nallowed = ["Gone", "Alive"]\n',
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
            expect(log.of('info')).toContain(`${ansi.named.name('Gone')} stopped asking, so its port was closed.`);
        });
    });

    it('closes every port on the router when stopped', () => {
        const { forwarder, settle, keys, net, ask } = setup('[plugins]\nallowed = ["X"]\n');
        forwarder.start();
        ask('X', ensure());
        settle(() => keys().length === 4);
        net.autoAdvanceMs = 1;
        forwarder.stop();
        expect(keys()).toEqual([]);
        expect(net.leaks).toBe(0);
    });

    it('cancels unfinished shutdown cleanup at its deadline and closes the stalled transport', () => {
        const { forwarder, settle, keys, net, log } = setup(
            '[bedrock]\nenabled = false\n',
            new FakeIgd({ natPmp: false }),
        );
        forwarder.start();
        settle(() => keys().length === 1);
        delayReplies(net, 'DeletePortMapping');
        net.autoAdvanceMs = 1;
        const before = net.time;
        forwarder.stop();
        expect(net.time - before).toBeLessThanOrEqual(3010);
        expect(net.leaks).toBe(0);
        expect(log.of('warn').some((m) => m.includes('cleanup did not finish'))).toBe(true);
        forwarder.stop();
        expect(net.leaks).toBe(0);
    });

    it('blocks on the network between shutdown polls instead of spinning', () => {
        const { forwarder, settle, keys, net } = setup('[bedrock]\nenabled = false\n', new FakeIgd({ natPmp: false }));
        forwarder.start();
        settle(() => keys().length === 1);
        delayReplies(net, 'DeletePortMapping');
        net.autoAdvanceMs = 1;
        let paused = 0;
        const pause = net.pause.bind(net);
        net.pause = (ms) => {
            paused += ms;
            pause(ms);
        };
        const before = net.time;
        forwarder.stop();
        expect(net.time - before).toBeLessThanOrEqual(3010);
        expect(paused).toBeGreaterThan(2000);
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
        '/html/login/index.html': { body: '<html><head><title>Speedport Konfigurationsprogramm</title></head>' },
    };
    const telekom = () => new FakeIgd({ upnp: false, natPmp: false, webPages: speedport });

    it('warns once when it starts, opens nothing and stops asking the router', () => {
        const { log, net, forwarder, settle } = setup(undefined, telekom());
        forwarder.start();
        settle(() => forwarder.refusal !== undefined);
        const sent = net.sent.length;
        settle(() => false, 60 * 60_000);

        expect(log.of('warn')).toHaveLength(1);
        expect(log.of('warn')[0]).toContain('UPnPumpkin is disabled: Telekom Speedport');
        expect(forwarder.refusal?.identity).toMatchObject({ manufacturer: 'Telekom' });
        expect(net.sent).toHaveLength(sent);
        expect(forwarder.snapshot.mappings.every((m) => m.state.kind === 'failed')).toBe(true);
    });

    it('keeps the refusal across a reload and warns again only when router settings changed', () => {
        const { files, log, forwarder, settle } = setup(undefined, telekom());
        forwarder.start();
        settle(() => forwarder.refusal !== undefined);

        forwarder.reload();
        expect(forwarder.refusal).toBeDefined();
        expect(log.of('warn')).toHaveLength(1);

        files.put(CONFIG_FILE, '[router]\nnat_pmp = false\n');
        forwarder.reload();
        expect(forwarder.refusal).toBeUndefined();
        settle(() => forwarder.refusal !== undefined);
        expect(log.of('warn')).toHaveLength(2);
    });

    it('tells other plugins why their port is not opened', () => {
        const { forwarder, settle, ask } = setup('[plugins]\nallowed = ["Other"]\n', telekom());
        forwarder.start();
        settle(() => forwarder.refusal !== undefined);
        const reply = ask('Other', ensure());
        expect(reply).toMatchObject({ ok: true, status: { kind: 'failed' } });
        expect(JSON.stringify(reply)).toContain('Telekom Speedport cannot be used');
    });
});
