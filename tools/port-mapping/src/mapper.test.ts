import { strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { RouterIdentity } from './identify.ts';
import { PortMapper } from './mapper.ts';
import { FakeIgd } from './testing/fake-igd.ts';
import { FakeNetwork, runSteps } from './testing/fake-network.ts';

const spec = { protocol: 'tcp', port: 8123, description: 'Packs' } as const;

function setup(igd: FakeIgd | null = new FakeIgd(), extra: Partial<ConstructorParameters<typeof PortMapper>[1]> = {}) {
    const net = new FakeNetwork(igd ? [igd] : []);
    const log: string[] = [];
    const mapper = new PortMapper(net, {
        upnp: true,
        natPmp: true,
        leaseSeconds: 3600,
        log: (m) => log.push(m),
        random: () => 0.5,
        ...extra
    });
    /** Ticks with the clock moving until the predicate holds. */
    const settle = (until: () => boolean, limitMs = 60_000) => {
        for (const start = net.time; !until() && net.time - start < limitMs; net.time += 10) mapper.tick();
        mapper.tick();
    };
    return { net, igd: igd ?? undefined, mapper, log, settle };
}

function delayMappingReply(net: FakeNetwork) {
    const dial = net.dial.bind(net);
    let blocked = true;
    net.dial = (to) => {
        const original = dial(to);
        return {
            abort: () => original.abort(),
            poll: () => {
                const connection = original.poll();
                if (!connection) return undefined;
                let mapping = false;
                return {
                    localAddress: connection.localAddress,
                    writable: () => connection.writable(),
                    close: () => connection.close(),
                    write: (bytes) => {
                        mapping ||= strFromU8(bytes).includes('#AddPortMapping');
                        connection.write(bytes);
                    },
                    read: (max) => (mapping && blocked ? null : connection.read(max))
                };
            }
        };
    };
    return () => {
        blocked = false;
    };
}

const open = (state: unknown) => (state as { kind: string }).kind === 'open';

describe('PortMapper', () => {
    it('opens a requested port and reports where players reach it', () => {
        const { igd, mapper, settle, net } = setup();
        expect(mapper.request('web', spec)).toEqual({ kind: 'pending' });
        settle(() => open(mapper.state('web')));

        expect(mapper.state('web')).toEqual({ kind: 'open', via: 'upnp', address: [93, 184, 216, 34], port: 8123 });
        expect(igd?.mappings.get('tcp:8123')).toMatchObject({
            internalPort: 8123,
            client: '192.168.1.50',
            description: 'Packs',
            leaseSeconds: 3600
        });
        expect(mapper.info()).toMatchObject({
            localAddress: [192, 168, 1, 50],
            gateway: { kind: 'upnp', address: [192, 168, 1, 1] },
            externalAddress: [93, 184, 216, 34]
        });
        expect(net.leaks).toBe(0);
    });

    it('does nothing and asks no router when this machine already has a public address', () => {
        const { net, mapper, settle } = setup(null);
        net.local = [93, 184, 216, 99];
        mapper.request('web', { ...spec, externalPort: 9000 });
        settle(() => open(mapper.state('web')));
        expect(mapper.state('web')).toEqual({ kind: 'open', via: 'public', address: [93, 184, 216, 99], port: 9000 });
        expect(net.sockets).toHaveLength(0);
        expect(net.connections).toHaveLength(0);
    });

    it('keeps working when requested again with the same spec, and replaces a mapping whose spec changed', () => {
        const { igd, mapper, settle } = setup();
        mapper.request('web', spec);
        settle(() => open(mapper.state('web')));
        expect(mapper.request('web', spec)).toMatchObject({ kind: 'open' });

        mapper.request('web', { ...spec, port: 9000 });
        settle(() => igd?.mappings.has('tcp:9000') === true && !igd.mappings.has('tcp:8123'));
        expect([...(igd?.mappings.keys() ?? [])]).toEqual(['tcp:9000']);
    });

    it('closes the port on the router when it is released', () => {
        const { igd, mapper, settle } = setup();
        mapper.request('web', spec);
        settle(() => open(mapper.state('web')));
        mapper.release('web');
        settle(() => igd?.mappings.size === 0);
        expect(igd?.mappings.size).toBe(0);
        expect(mapper.state('web')).toBeUndefined();
    });

    it.each([true, false])('retains a compatible physical mapping until its final owner releases (UPnP=%s)', (upnp) => {
        const { igd, mapper, settle, net } = setup(new FakeIgd({ upnp }), { upnp });
        mapper.request('own:java', spec);
        mapper.request('plugin:client:web', { ...spec, externalPort: 8123, description: 'Client' });
        settle(() => open(mapper.state('own:java')) && open(mapper.state('plugin:client:web')));
        const adds = upnp
            ? igd?.actions.filter((a) => a === 'AddPortMapping').length
            : net.sent.filter((s) => s.data.length === 12).length;
        expect(adds).toBe(1);
        mapper.release('own:java');
        settle(() => false, 1000);
        expect(igd?.mappings.get('tcp:8123')?.internalPort).toBe(8123);
        expect(mapper.state('plugin:client:web')).toMatchObject({ kind: 'open', port: 8123 });
        mapper.release('plugin:client:web');
        settle(() => igd?.mappings.size === 0);
        expect(igd?.mappings.size).toBe(0);
        expect(net.leaks).toBe(0);
    });

    it('retains a pending mapping when its initiating owner leaves but another owner remains', () => {
        const { igd, mapper, settle, net } = setup(new FakeIgd({ natPmp: false }));
        const resume = delayMappingReply(net);
        mapper.request('first', spec);
        mapper.request('second', { ...spec, description: 'Other owner' });
        settle(() => igd?.mappings.has('tcp:8123') === true);
        mapper.release('first');
        resume();
        settle(() => open(mapper.state('second')));
        expect(mapper.state('second')).toMatchObject({ kind: 'open', port: 8123 });
        expect(igd?.actions.filter((a) => a === 'AddPortMapping')).toHaveLength(1);
        runSteps(net, mapper.releaseAll());
        expect(igd?.mappings.size).toBe(0);
        expect(net.leaks).toBe(0);
    });

    it('renews the lease at half its length', () => {
        const { igd, mapper, settle, net } = setup(new FakeIgd(), { leaseSeconds: 100 });
        mapper.request('web', spec);
        settle(() => open(mapper.state('web')));
        const adds = () => igd?.actions.filter((a) => a === 'AddPortMapping').length;
        expect(adds()).toBe(1);

        settle(() => false, 49_000);
        expect(adds()).toBe(1);
        settle(() => (adds() ?? 0) > 1, 5000);
        expect(adds()).toBe(2);
        expect(net.leaks).toBe(0);
    });

    it('asks for another public port when the first is taken', () => {
        const { igd, mapper, settle } = setup(new FakeIgd({ takenPorts: [8123] }));
        mapper.request('web', spec);
        settle(() => open(mapper.state('web')));
        expect(mapper.state('web')).toMatchObject({ kind: 'open', port: 33024 });
        expect(igd?.mappings.has('tcp:33024')).toBe(true);
    });

    it('opens several ports, one operation at a time', () => {
        const { igd, mapper, settle } = setup();
        mapper.request('java', { protocol: 'tcp', port: 25565, description: 'Java' });
        mapper.request('bedrock', { protocol: 'udp', port: 19132, description: 'Bedrock' });
        settle(() => open(mapper.state('java')) && open(mapper.state('bedrock')));
        expect([...(igd?.mappings.keys() ?? [])].sort()).toEqual(['tcp:25565', 'udp:19132']);
    });

    it('fails with the reason when no router answers, and tries again later with growing waits', () => {
        const { net, mapper, settle, log } = setup(null);
        mapper.request('web', spec);
        settle(() => mapper.state('web')?.kind === 'failed');
        expect(mapper.state('web')).toEqual({
            kind: 'failed',
            reason: expect.stringContaining('no router answered the search')
        });
        expect(log[0]).toContain('No router could open ports');

        const searches = () => net.sent.filter((s) => s.to.port === 1900).length;
        const before = searches();
        settle(() => false, 25_000);
        expect(searches()).toBe(before);
        settle(() => searches() > before, 10_000);
        expect(searches()).toBeGreaterThan(before);
    });

    it('recovers when a router shows up after a failed search', () => {
        const { net, mapper, settle } = setup(null);
        mapper.request('web', spec);
        settle(() => mapper.state('web')?.kind === 'failed');
        net.routers.push(new FakeIgd());
        settle(() => open(mapper.state('web')), 60_000);
        expect(mapper.state('web')).toMatchObject({ kind: 'open' });
    });

    it('fails a request made right after a failed search without searching again', () => {
        const { net, mapper, settle } = setup(null);
        mapper.request('a', spec);
        settle(() => mapper.state('a')?.kind === 'failed');
        const sent = net.sent.length;
        expect(mapper.request('b', { ...spec, port: 1 })).toMatchObject({ kind: 'failed' });
        mapper.tick();
        expect(net.sent.length).toBe(sent);
    });

    it('refuses to map behind carrier-grade NAT, where nobody can connect in', () => {
        const { mapper, settle, igd } = setup(new FakeIgd({ externalAddress: [100, 72, 3, 4] }));
        mapper.request('web', spec);
        settle(() => mapper.state('web')?.kind === 'failed');
        expect(mapper.state('web')).toEqual({
            kind: 'failed',
            reason: expect.stringContaining('100.72.3.4, which is not public')
        });
        expect(igd?.mappings.size).toBe(0);
    });

    it("fails with the router's reason when it refuses the mapping, and looks again later", () => {
        const { mapper, settle, igd } = setup(new FakeIgd({ failMappingWith: 501 }));
        mapper.request('web', spec);
        settle(() => mapper.state('web')?.kind === 'failed');
        expect(mapper.state('web')).toEqual({
            kind: 'failed',
            reason: expect.stringContaining('would not open port 8123: Action Failed (501)')
        });

        if (igd) igd.options.failMappingWith = undefined;
        settle(() => open(mapper.state('web')), 120_000);
        expect(mapper.state('web')).toMatchObject({ kind: 'open' });
    });

    it('closes everything when told to release all, even with the router busy', () => {
        const { net, igd, mapper, settle } = setup();
        mapper.request('web', spec);
        settle(() => open(mapper.state('web')));
        runSteps(net, mapper.releaseAll());
        expect(igd?.mappings.size).toBe(0);
        expect(net.leaks).toBe(0);
    });

    it('releasing before the router was found costs nothing', () => {
        const { net, mapper } = setup(null);
        mapper.request('web', spec);
        mapper.release('web');
        mapper.tick();
        expect(net.sockets).toHaveLength(0);
        runSteps(net, mapper.releaseAll());
    });

    it('warns about a failure once, however often it retries, and again after it recovered', () => {
        const warnings: string[] = [];
        const { net, mapper, settle } = setup(null, { log: (m, level) => level === 'warn' && warnings.push(m) });
        mapper.request('web', spec);
        settle(() => false, 30 * 60_000);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('No router could open ports');

        net.routers.push(new FakeIgd());
        settle(() => open(mapper.state('web')), 15 * 60_000);
        expect(open(mapper.state('web'))).toBe(true);

        net.routers.length = 0;
        mapper.release('web');
        mapper.request('web', { ...spec, port: 8124 });
        settle(() => false, 30 * 60_000);
        expect(warnings.filter((w) => w.startsWith('No router could open ports'))).toHaveLength(2);
    });

    it('says a router was found once even when it is found again after a failure', () => {
        const { igd, mapper, settle, log } = setup(new FakeIgd({ failMappingWith: 501 }));
        mapper.request('web', spec);
        settle(() => mapper.state('web')?.kind === 'failed');
        settle(() => false, 10 * 60_000);
        if (igd) igd.options.failMappingWith = undefined;
        settle(() => open(mapper.state('web')), 15 * 60_000);
        expect(log.filter((m) => m.startsWith('Found a upnp router'))).toHaveLength(1);
    });
});

describe('PortMapper with a screen', () => {
    const speedport = {
        '/html/login/index.html': { body: '<html><head><title>Speedport Konfigurationsprogramm</title>' }
    };
    const screen = (identity: RouterIdentity) =>
        identity.manufacturer?.startsWith('Telekom') ? 'Telekom routers have no UPnP' : undefined;

    function screened(igd: FakeIgd) {
        const refusals: { identity: RouterIdentity; reason: string }[] = [];
        const warnings: string[] = [];
        const made = setup(igd, {
            screen,
            onRefused: (r) => refusals.push(r),
            log: (m, level) => level === 'warn' && warnings.push(m)
        });
        return { ...made, refusals, warnings };
    }

    it('turns a router down by its web interface, fails the ports and never asks it anything', () => {
        const { net, mapper, settle, refusals, warnings } = screened(
            new FakeIgd({ upnp: false, natPmp: false, webPages: speedport })
        );
        mapper.request('web', spec);
        settle(() => mapper.state('web')?.kind === 'failed');
        settle(() => false, 60 * 60_000);

        expect(mapper.state('web')).toEqual({
            kind: 'failed',
            reason: 'Telekom Speedport cannot be used: Telekom routers have no UPnP'
        });
        expect(refusals).toEqual([
            { identity: { manufacturer: 'Telekom', name: 'Speedport', source: 'web' }, reason: expect.any(String) }
        ]);
        expect(mapper.info().refused?.identity.manufacturer).toBe('Telekom');
        expect(warnings).toEqual([]);
        expect(net.sent).toHaveLength(0);
        expect(net.leaks).toBe(0);
    });

    it('fails ports requested after the router was turned down', () => {
        const { mapper, settle } = screened(new FakeIgd({ upnp: false, natPmp: false, webPages: speedport }));
        mapper.request('a', spec);
        settle(() => mapper.state('a')?.kind === 'failed');
        expect(mapper.request('b', { ...spec, port: 1 })).toEqual({
            kind: 'failed',
            reason: 'Telekom Speedport cannot be used: Telekom routers have no UPnP'
        });
    });

    it('turns a UPnP router down by what its description says, before any action is sent to it', () => {
        const igd = new FakeIgd({ device: { manufacturer: 'Telekom AG', modelName: 'Media Receiver' } });
        const { mapper, settle, refusals } = screened(igd);
        mapper.request('web', spec);
        settle(() => mapper.state('web')?.kind === 'failed');
        expect(refusals[0]?.identity).toMatchObject({ manufacturer: 'Telekom AG', model: 'Media Receiver' });
        expect(igd.actions).toEqual([]);
    });

    it('uses a router the screen lets through, and reports its make and model', () => {
        const igd = new FakeIgd({ device: { manufacturer: 'AVM Berlin', modelName: 'FRITZ!Box 7590' } });
        const { mapper, settle, refusals } = screened(igd);
        mapper.request('web', spec);
        settle(() => open(mapper.state('web')));
        expect(refusals).toEqual([]);
        expect(mapper.info().identity).toMatchObject({ manufacturer: 'AVM Berlin', model: 'FRITZ!Box 7590' });
    });
});
