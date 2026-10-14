import { strFromU8, strToU8 } from 'fflate';
import { expect, it } from 'vitest';
import * as api from './index.ts';

function setup() {
    expect(api.PieSession).toBeTypeOf('function');
    let now = 0;
    let online = false;
    let protocol = 0;
    const ops: string[] = [];
    const namespaces = new Set<string>();
    const transitions: string[] = [];
    const session = new api.PieSession({
        now: () => now,
        onTransition: (state) => transitions.push(state.kind),
        send: (_recipient, bytes) => {
            const r = JSON.parse(strFromU8(bytes));
            ops.push(r.op);
            if (!online) throw new Error('missing');
            const bodies: Record<string, Record<string, unknown>> = {
                ping: {
                    ping: {
                        protocol,
                        name: 'PumpkinPIE',
                        version: '0.2.3',
                        placeholders: 11,
                        expansions: namespaces.size,
                    },
                },
                register_expansion: {
                    registered_expansion: {
                        namespace: r.namespace,
                        placeholders: r.placeholders,
                        cache:
                            r.cache?.kind === 'ttl'
                                ? { kind: 'ttl', ms: Math.min(r.cache.ms, 60000) }
                                : { kind: 'never' },
                    },
                },
                unregister_expansion: { unregistered: { namespaces: [...namespaces] } },
            };
            if (r.op === 'register_expansion') namespaces.add(r.namespace);
            if (r.op === 'unregister_expansion') namespaces.clear();
            return strToU8(JSON.stringify({ ok: true, ...bodies[r.op] }));
        },
    });
    return {
        session,
        ops,
        namespaces,
        transitions,
        time: (ms: number) => {
            now = ms;
        },
        online: (value: boolean) => {
            online = value;
        },
        protocol: (value: number) => {
            protocol = value;
        },
    };
}
it('retries with bounded backoff, warns on transitions and recovers desired expansions', () => {
    const f = setup();
    f.session.registerExpansion('ranks', { prefix: () => 'Admin' }, { kind: 'ttl', ms: 90000 });
    f.session.tick();
    f.session.tick();
    expect(f.ops).toEqual(['ping']);
    f.time(999);
    f.session.tick();
    expect(f.ops).toHaveLength(1);
    f.time(1000);
    f.session.tick();
    f.time(2999);
    f.session.tick();
    expect(f.ops).toHaveLength(2);
    f.time(3000);
    f.session.tick();
    expect(f.transitions).toEqual([]);
    f.online(true);
    f.time(7000);
    f.session.tick();
    expect(f.session.state.kind).toBe('ready');
    expect(f.namespaces.has('ranks')).toBe(true);
    expect(f.session.appliedCache('ranks')).toEqual({ kind: 'ttl', ms: 60000 });
    expect(f.transitions).toEqual(['ready']);
    f.namespaces.clear();
    f.time(37000);
    f.session.tick();
    expect(f.namespaces.has('ranks')).toBe(true);
    expect(f.transitions).toEqual(['ready']);
    f.online(false);
    f.time(67000);
    f.session.tick();
    expect(f.session.state.kind).toBe('unavailable');
    expect(f.session.appliedCache('ranks')).toBeUndefined();
    expect(f.transitions).toEqual(['ready', 'unavailable']);
    for (const time of [68000, 70000, 74000, 82000, 98000, 128000, 158000]) {
        f.time(time);
        f.session.tick();
    }
    const n = f.ops.length;
    f.time(187999);
    f.session.tick();
    expect(f.ops).toHaveLength(n);
    f.time(188000);
    f.session.tick();
    expect(f.ops).toHaveLength(n + 1);
});
it('negotiates incompatible providers without registering and recovers protocol 0', () => {
    const f = setup();
    f.online(true);
    f.protocol(1);
    f.session.registerExpansion('ranks', { prefix: () => 'Admin' });
    f.session.tick();
    expect(f.session.state.kind).toBe('incompatible');
    expect(f.ops).toEqual(['ping']);
    f.protocol(0);
    f.time(1000);
    f.session.tick();
    expect(f.session.state.kind).toBe('ready');
});
it('unregisters all owned namespaces once on reachable stop and stays stopped', () => {
    const f = setup();
    f.online(true);
    f.session.registerExpansion('ranks', { prefix: () => 'Admin' });
    f.session.registerExpansion('waypoints', { count: () => '2' });
    f.session.tick();
    f.session.stop();
    f.session.stop();
    f.time(100000);
    f.session.tick();
    expect(f.namespaces.size).toBe(0);
    expect(f.ops.filter((op) => op === 'unregister_expansion')).toHaveLength(1);
    expect(() => f.session.registerExpansion('extra', {})).toThrow(api.InputError);
    const offline = setup();
    offline.session.tick();
    offline.session.stop();
    expect(offline.ops).toEqual(['ping']);
});
it('clears local callbacks without IPC during host teardown', () => {
    const f = setup();
    f.online(true);
    f.session.registerExpansion('ranks', { prefix: () => 'Admin' });
    f.session.tick();
    expect(f.ops).toEqual(['ping', 'register_expansion']);

    f.session.stop({ unregister: false });

    expect(f.ops).toEqual(['ping', 'register_expansion']);
    expect(() => f.session.registerExpansion('extra', {})).toThrow(api.InputError);
    const reply = f.session.router.handle(
        'PumpkinPIE',
        strToU8('{"op":"on_request","namespace":"ranks","id":"ranks_prefix","name":"prefix"}'),
    );
    expect(JSON.parse(strFromU8(reply))).toEqual({ ok: true, on_request: {} });
});
it('shares the callback guard with session client and restores it after stop re-entry', () => {
    const f = setup();
    f.online(true);
    f.session.registerExpansion('ranks', {
        prefix: () => {
            f.session.stop();
            return 'bad';
        },
    });
    f.session.tick();
    const reply = f.session.router.handle(
        'PumpkinPIE',
        strToU8('{"op":"on_request","namespace":"ranks","id":"ranks_prefix","name":"prefix"}'),
    );
    expect(JSON.parse(strFromU8(reply)).ok).toBe(false);
    expect(f.session.state.kind).toBe('ready');
    f.session.stop();
    expect(f.namespaces.size).toBe(0);
});
it('rejects invalid desired registrations before changing callback ownership', () => {
    const f = setup();
    const handlers = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => ['x'.repeat(120) + i, () => 'value']));
    expect(() => f.session.registerExpansion('ranks', handlers)).toThrow(api.InputError);
    const reply = f.session.router.handle(
        'PumpkinPIE',
        strToU8('{"op":"on_request","namespace":"ranks","id":"ranks_x","name":"x"}'),
    );
    expect(JSON.parse(strFromU8(reply))).toEqual({ ok: true, on_request: {} });
});
it('cleans up partial registrations when a reachable provider rejects another namespace', () => {
    let unregisters = 0;
    const session = new api.PieSession({
        now: () => 0,
        send: (_recipient, bytes) => {
            const request = JSON.parse(strFromU8(bytes));
            if (request.op === 'ping')
                return strToU8(
                    '{"ok":true,"ping":{"protocol":0,"name":"PumpkinPIE","version":"0.2.3","placeholders":11,"expansions":0}}',
                );
            if (request.op === 'unregister_expansion') {
                unregisters++;
                return strToU8('{"ok":true,"unregistered":{"namespaces":["ranks"]}}');
            }
            if (request.namespace === 'waypoints') return strToU8('{"ok":false,"error":"refused"}');
            return strToU8(
                '{"ok":true,"registered_expansion":{"namespace":"ranks","placeholders":["prefix"],"cache":{"kind":"never"}}}',
            );
        },
    });
    session.registerExpansion('ranks', { prefix: () => 'Admin' });
    session.registerExpansion('waypoints', { count: () => '2' });
    session.tick();
    expect(session.state.kind).toBe('unavailable');
    session.stop();
    session.stop();
    expect(unregisters).toBe(1);
});
