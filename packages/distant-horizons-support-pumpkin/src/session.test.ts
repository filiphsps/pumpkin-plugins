import { MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { unavailableChunkLoader, unavailableTerrainGenerator } from '@pumpkin-plugins/terrain';
import { describe, expect, it } from 'vitest';
import { readSettings } from './config/load.ts';
import { LodCache } from './lod/cache.ts';
import { Reader } from './protocol/bytes.ts';
import { packet } from './protocol/messages.ts';
import { type Peer, Sessions } from './session.ts';

function fixture(measureNow = () => 1000, now = () => 1000) {
    const files = new MemoryFiles(),
        log = new MemoryLogger();
    const settings = readSettings(files, log);
    settings.blocks_per_tick = 16384;
    settings.packets_per_tick = 16;
    const cache = new LodCache(files, settings.memory_cache_entries, settings.disk_cache_entries),
        sessions = new Sessions(settings, cache, log, now, measureNow);
    const sent: Uint8Array[] = [];
    const reports: string[] = [];
    let reads = 0;
    const peer: Peer = {
        name: 'Alice',
        level: 'world',
        dimension: 'minecraft:overworld',
        x: 32,
        z: 32,
        terrain: {
            minY: 0,
            height: 1,
            chunkLoader: unavailableChunkLoader,
            terrainGenerator: unavailableTerrainGenerator,
            sample: () => {
                reads++;
                return { material: 'minecraft:plains_DH-BSW_minecraft:stone', skyLight: 15, blockLight: 0 };
            }
        },
        borderBounds: { minX: -1_000_000, maxX: 1_000_000, minZ: -1_000_000, maxZ: 1_000_000 },
        insideBorder: () => true,
        send: (bytes) => sent.push(bytes),
        report: (message) => reports.push(message)
    };
    const peers = {
        withPeer: (name: string, use: (p: Peer) => void) => {
            if (name !== peer.name) return false;
            use(peer);
            return true;
        }
    };
    const request = (tracker = 1, level = 'world', x = 0, timestamp?: number) =>
        packet(7)
            .int(tracker)
            .string(level)
            .words((x & 0x0fff_ffff) >>> 24, (((x & 0x0fff_ffff) << 8) | 6) >>> 0)
            .bool(timestamp !== undefined)
            .bytes(timestamp === undefined ? new Uint8Array() : packet(0).timestamp(timestamp).finish().subarray(4))
            .finish();
    sessions.receive(peer, packet(3).string(peer.dimension).finish());
    sent.length = 0;
    const ids = () =>
        sent.map((bytes) => {
            const r = new Reader(bytes);
            r.short();
            return r.short();
        });
    return { files, settings, cache, sessions, peer, peers, sent, reports, request, ids, log, reads: () => reads };
}

function clientConfig(
    options: {
        plan?: number;
        generationDistance?: number;
        generationRate?: number;
        realTimeUpdates?: boolean;
        realTimeDistance?: number;
        sync?: boolean;
        syncDistance?: number;
        syncRate?: number;
        bandwidthKbps?: number;
    } = {}
): Uint8Array {
    return packet(4)
        .byte(options.plan ?? 2)
        .int(options.generationDistance ?? 128)
        .int(0)
        .int(0)
        .int(0)
        .int(options.generationRate ?? 20)
        .bool(options.realTimeUpdates ?? false)
        .int(options.realTimeDistance ?? 0)
        .bool(options.sync ?? true)
        .int(options.syncDistance ?? 128)
        .int(options.syncRate ?? 50)
        .int(options.bandwidthKbps ?? 0)
        .finish();
}

function readSessionConfig(bytes: Uint8Array) {
    const input = new Reader(bytes);
    input.short();
    if (input.short() !== 4) throw new Error('Expected a DH session config packet');
    const result = {
        plan: input.byte(),
        generationDistance: input.int(),
        generationCenterX: input.int(),
        generationCenterZ: input.int(),
        generationMaxRadius: input.int(),
        generationRate: input.int(),
        realTimeUpdates: input.bool(),
        realTimeDistance: input.int(),
        sync: input.bool(),
        syncDistance: input.int(),
        syncRate: input.int(),
        bandwidthKbps: input.int()
    };
    input.end();
    return result;
}

describe('DH protocol contracts', () => {
    it('acknowledges client configuration updates with negotiated request classes', () => {
        const f = fixture();
        f.settings.generation_requests_per_second = 19;
        f.settings.sync_requests_per_second = 10;
        f.settings.requests_per_player = 16;
        f.sent.length = 0;

        f.sessions.receive(
            f.peer,
            clientConfig({
                generationDistance: 64,
                generationRate: 100,
                sync: true,
                syncDistance: 256,
                syncRate: 100,
                bandwidthKbps: 500
            })
        );

        expect(f.ids()).toEqual([4]);
        expect(readSessionConfig(f.sent[0] ?? new Uint8Array())).toMatchObject({
            generationDistance: 64,
            generationRate: 16,
            sync: true,
            syncDistance: 128,
            syncRate: 10,
            bandwidthKbps: 500
        });
    });

    it('serves sync requests while generation is disabled', () => {
        const f = fixture();
        f.cache.put('world:0:0', { updated: 1000, data: new Uint8Array(64).fill(1) });
        f.sent.length = 0;
        f.sessions.receive(f.peer, clientConfig({ plan: 3, sync: true }));
        f.sent.length = 0;

        f.sessions.receive(f.peer, f.request(7, 'world', 0, 0));
        f.sessions.tick(f.peers);

        expect(f.ids()).toEqual([10, 8]);
    });

    it('uses the client nearest-edge distance at positive and negative range boundaries', () => {
        const f = fixture();
        f.peer.x = 0;
        f.peer.z = 0;

        f.sessions.receive(f.peer, f.request(1, 'world', 32));
        f.sessions.receive(f.peer, f.request(2, 'world', -33));

        expect(f.ids()).toEqual([]);
        expect(f.sessions.status()).toContain('2 pending LOD request(s)');
    });

    it('preserves pending trackers and negotiated settings on a matching init', () => {
        const f = fixture();
        f.cache.put('world:0:0', { updated: 1000, data: new Uint8Array(64).fill(1) });
        f.sessions.receive(f.peer, f.request(42));
        f.sessions.receive(f.peer, clientConfig({ generationRate: 7, syncRate: 9 }));
        f.sessions.receive(f.peer, packet(3).string(f.peer.dimension).finish());
        f.sent.length = 0;

        f.sessions.tick(f.peers);

        expect(f.ids()).toContain(8);
        expect(f.sessions.status()).toContain('1 served');
    });

    it('continues cached delivery while forced capture work is active', () => {
        const f = fixture();
        f.peer.terrain.height = 16;
        f.cache.put('world:0:0', { updated: 1000, data: new Uint8Array(64).fill(1) });
        f.sessions.forceGenerate(f.peer, 96, 32);
        f.sessions.receive(f.peer, f.request());

        f.sessions.tick(f.peers);

        expect(f.ids()).toEqual([10, 8]);
        expect(f.reads()).toBeGreaterThan(0);
    });

    it('delivers a cached request while terrain misses wait with zero capture budget', () => {
        const f = fixture();
        f.settings.blocks_per_tick = 64;
        f.cache.put('world:2:0', { updated: 1000, data: new Uint8Array(64).fill(3) });
        f.sessions.receive(f.peer, f.request(1));
        f.sessions.receive(f.peer, f.request(2, 'world', 1));
        f.sessions.receive(f.peer, f.request(3, 'world', 2));

        f.sessions.tick(f.peers, 45);

        expect(f.ids()).toEqual([10, 8]);
        expect(f.reads()).toBe(0);
        expect(f.sessions.status()).toContain('2 pending LOD request(s)');
        expect(f.sessions.status()).toContain('1 served');
    });

    it('lets a cached response bypass a full per-player capture slot', () => {
        const f = fixture();
        f.settings.blocks_per_tick = 64;
        f.settings.requests_per_player = 1;
        f.cache.put('world:2:0', { updated: 1000, data: new Uint8Array(64).fill(3) });
        f.sessions.receive(f.peer, f.request(1));
        f.sessions.receive(f.peer, f.request(2, 'world', 1));
        f.sessions.tick(f.peers);
        f.sessions.tick(f.peers);
        expect(f.sessions.status()).toContain('2 pending LOD request(s)');

        f.sessions.receive(f.peer, f.request(3, 'world', 2));
        f.sessions.tick(f.peers);

        expect(f.ids()).toContain(8);
        expect(f.sessions.status()).toContain('1 served');
        expect(f.sessions.status()).toContain('2 pending LOD request(s)');
    });

    it('adopts requests while an earlier response is queued and keeps that transfer on config changes', () => {
        const f = fixture();
        f.settings.cached_packets_per_tick = 0;
        f.cache.put('world:0:0', { updated: 1000, data: new Uint8Array(64).fill(1) });
        f.cache.put('world:1:0', { updated: 1000, data: new Uint8Array(64).fill(2) });
        f.sessions.receive(f.peer, f.request(10));
        f.sessions.tick(f.peers);
        expect(f.sessions.status()).toContain('1 response(s)');

        f.sessions.receive(f.peer, f.request(10));
        expect(f.sessions.status()).toContain('1 response(s)');
        expect(f.ids()).toEqual([]);

        f.sessions.receive(f.peer, f.request(11, 'world', 1));
        expect(f.sessions.status()).toContain('1 pending LOD request(s)');
        f.sessions.tick(f.peers);
        expect(f.sessions.status()).toContain('2 response(s)');

        f.sessions.receive(f.peer, clientConfig({ plan: 3 }));
        expect(f.sessions.status()).toContain('2 response(s)');
        f.settings.cached_packets_per_tick = 16;
        f.sessions.tick(f.peers);

        expect(f.ids()).toContain(4);
        expect(f.ids().filter((id) => id === 8)).toHaveLength(2);
        expect(f.sessions.status()).toContain('2 served');
    });

    it('applies and updates the nonzero client bandwidth limit during a transfer', () => {
        let now = 0;
        const f = fixture(
            () => now,
            () => now
        );
        f.settings.cached_packets_per_tick = 1;
        f.cache.put('world:0:0', { updated: 0, data: new Uint8Array(60_000).fill(1) });
        f.sessions.receive(f.peer, clientConfig({ bandwidthKbps: 1 }));
        f.sent.length = 0;
        f.sessions.receive(f.peer, f.request());

        f.sessions.tick(f.peers);
        expect(f.sent).toHaveLength(0);

        now = 19_999;
        f.sessions.tick(f.peers);
        expect(f.sent).toHaveLength(0);

        now = 20_000;
        f.sessions.tick(f.peers);
        expect(f.ids()).toEqual([10]);
        expect(readFragment(f.sent[0] ?? new Uint8Array()).data).toHaveLength(19_987);

        f.sessions.receive(f.peer, clientConfig({ bandwidthKbps: 2 }));
        f.sent.length = 0;

        now = 35_006;
        f.sessions.tick(f.peers);
        expect(f.ids()).toEqual([]);

        now = 35_007;
        f.sessions.tick(f.peers);
        expect(f.ids()).toEqual([10]);
        expect(readFragment(f.sent[0] ?? new Uint8Array()).data).toHaveLength(30_000);

        now = 45_032;
        f.sent.length = 0;
        f.sessions.tick(f.peers);
        expect(f.ids()).toEqual([10]);
        expect(readFragment(f.sent[0] ?? new Uint8Array()).data).toHaveLength(10_013);

        now = 45_033;
        f.sessions.tick(f.peers);
        expect(f.ids()).toEqual([10, 8]);
    });

    it('resizes a buffered fragment before sending after a bandwidth decrease', () => {
        let now = 0;
        const f = fixture(
            () => now,
            () => now
        );
        f.cache.put('world:0:0', { updated: 0, data: new Uint8Array(60_000).fill(1) });
        f.sessions.receive(f.peer, clientConfig({ bandwidthKbps: 2 }));
        f.sent.length = 0;
        f.sessions.receive(f.peer, f.request());

        f.sessions.tick(f.peers);
        now = 10_000;
        f.sessions.tick(f.peers);
        expect(f.sent).toHaveLength(0);

        f.sessions.receive(f.peer, clientConfig({ bandwidthKbps: 1 }));
        f.sent.length = 0;
        f.sessions.tick(f.peers);

        expect(f.ids()).toEqual([10]);
        expect(readFragment(f.sent[0] ?? new Uint8Array()).data).toHaveLength(19_987);
    });

    it('keeps competing clients assembling large responses before receiver timeout', () => {
        let now = 0;
        const f = fixture(
            () => now,
            () => now
        );
        f.settings.refresh_seconds = 3600;
        f.cache.put('world:0:0', { updated: 0, data: new Uint8Array(60_000).fill(1) });
        f.cache.put('world:1:0', { updated: 0, data: new Uint8Array(60_000).fill(2) });
        const bobSent: Uint8Array[] = [];
        const bob: Peer = { ...f.peer, name: 'Bob', send: (bytes) => bobSent.push(bytes) };
        const peers = {
            withPeer: (name: string, use: (peer: Peer) => void) => {
                const peer = name === f.peer.name ? f.peer : name === bob.name ? bob : undefined;
                if (!peer) return false;
                use(peer);
                return true;
            }
        };
        f.sessions.receive(bob, packet(3).string(bob.dimension).finish());
        f.sessions.receive(f.peer, clientConfig({ bandwidthKbps: 1 }));
        f.sessions.receive(bob, clientConfig({ bandwidthKbps: 1 }));
        f.sent.length = 0;
        bobSent.length = 0;
        f.sessions.receive(f.peer, f.request(1));
        f.sessions.receive(bob, f.request(2, 'world', 1));

        const buffers = new Map<number, { lastAccess: number; chunks: Uint8Array[] }>();
        const completed = new Map<number, Uint8Array>();
        const expired: number[] = [];
        const receive = (messages: Uint8Array[], at: number) => {
            for (const message of messages) {
                const input = new Reader(message);
                input.short();
                const id = input.short();
                if (id === 10) {
                    const buffer = input.int();
                    const length = input.int();
                    const data = input.bytes(length);
                    const first = input.bool();
                    input.end();
                    let current = buffers.get(buffer);
                    if (current && at - current.lastAccess >= 30_000) {
                        buffers.delete(buffer);
                        expired.push(buffer);
                        current = undefined;
                    }
                    if (first) current = { lastAccess: at, chunks: [] };
                    if (!current) throw new Error('DH receiver buffer expired before the next fragment');
                    current.lastAccess = at;
                    current.chunks.push(data);
                    buffers.set(buffer, current);
                } else if (id === 8) {
                    const tracker = input.int();
                    expect(input.bool()).toBe(true);
                    const buffer = input.int();
                    input.int();
                    input.end();
                    const result = buffers.get(buffer);
                    if (!result || at - result.lastAccess >= 30_000) {
                        throw new Error('DH receiver had no complete buffer when the final response arrived');
                    }
                    completed.set(tracker, concat(result.chunks));
                }
            }
            messages.length = 0;
        };

        for (now = 0; now <= 70_000; now += 50) {
            f.sessions.tick(peers);
            receive(f.sent, now);
            receive(bobSent, now);
        }

        expect(expired).toEqual([]);
        expect(completed.get(1)).toEqual(new Uint8Array(60_000).fill(1));
        expect(completed.get(2)).toEqual(new Uint8Array(60_000).fill(2));
    });

    it('cancels an active transfer and releases its retained payload and send lock', () => {
        let now = 0;
        const f = fixture(
            () => now,
            () => now
        );
        f.settings.cached_packets_per_tick = 1;
        f.cache.put('world:0:0', { updated: 1000, data: new Uint8Array(60_000).fill(1) });
        f.cache.put('world:1:0', { updated: 1000, data: new Uint8Array(64).fill(2) });
        f.sessions.receive(f.peer, clientConfig({ bandwidthKbps: 1 }));
        f.sent.length = 0;
        f.sessions.receive(f.peer, f.request(1));
        f.sessions.receive(f.peer, f.request(2, 'world', 1));
        f.sessions.tick(f.peers);
        expect(f.sessions.status()).toContain('2 response(s)');

        now = 20_000;
        f.sessions.tick(f.peers);
        expect(f.ids()).toEqual([10]);
        expect(f.sessions.status()).toContain('60064 logical queued response bytes retained');

        f.sessions.receive(f.peer, packet(5).int(1).finish());
        expect(f.sessions.status()).toContain('1 cancelled');
        expect(f.sessions.status()).toContain('64 logical queued response bytes retained');

        now = 20_076;
        f.sessions.tick(f.peers);
        expect(f.ids()).toEqual([10]);
        now = 20_077;
        f.sessions.tick(f.peers);
        expect(f.ids()).toEqual([10, 10]);
        expect(readFragment(f.sent[1] ?? new Uint8Array()).data).toEqual(new Uint8Array(64).fill(2));
        now = 20_094;
        f.sessions.tick(f.peers);
        expect(f.ids()).toEqual([10, 10, 8]);
    });

    it('rotates transfer service so a small response finishes beside a large response', () => {
        const f = fixture();
        f.settings.cached_packets_per_tick = 1;
        f.cache.put('world:0:0', { updated: 1000, data: new Uint8Array(60_000).fill(1) });
        f.cache.put('world:1:0', { updated: 1000, data: new Uint8Array(64).fill(2) });
        const bobSent: Uint8Array[] = [];
        const bob: Peer = { ...f.peer, name: 'Bob', send: (bytes) => bobSent.push(bytes) };
        const peers = {
            withPeer: (name: string, use: (peer: Peer) => void) => {
                const peer = name === f.peer.name ? f.peer : name === bob.name ? bob : undefined;
                if (!peer) return false;
                use(peer);
                return true;
            }
        };
        f.sessions.receive(bob, packet(3).string(bob.dimension).finish());
        f.sent.length = 0;
        bobSent.length = 0;

        f.sessions.receive(f.peer, f.request(1));
        f.sessions.receive(bob, f.request(2, 'world', 1));
        for (let tick = 0; tick < 4; tick++) f.sessions.tick(peers);

        const ids = bobSent.map((bytes) => {
            const input = new Reader(bytes);
            input.short();
            return input.short();
        });
        expect(ids).toContain(8);
        expect(f.sessions.status()).toContain('1 served');
    });

    it('finishes one response before continuing a different packet-budget lane', () => {
        const f = fixture();
        f.settings.packets_per_tick = 1;
        f.settings.cached_packets_per_tick = 1;
        f.cache.put('world:0:0', { updated: 1000, data: new Uint8Array(64).fill(1) });
        f.sessions.receive(f.peer, f.request(1));
        f.sessions.receive(f.peer, f.request(2, 'world', 1));

        f.sessions.tick(f.peers);

        expect(f.ids()).toEqual([10]);
        expect(f.sessions.status()).toContain('2 response(s)');

        f.sent.length = 0;
        f.sessions.tick(f.peers);

        expect(f.ids()).toEqual([8, 10]);
        expect(f.sessions.status()).toContain('1 served');
    });
});

describe('DH sessions', () => {
    it('rejects unavailable requests at zero capture budget and then serves cached data', () => {
        const f = fixture();
        f.settings.blocks_per_tick = 64;
        f.cache.put('world:0:0', { updated: 1000, data: new Uint8Array(64).fill(1) });
        let prepareCalls = 0;
        f.peer.terrain.prepare = () => {
            prepareCalls++;
            return { status: 'unavailable', reason: 'Chunk is not loaded' };
        };
        let tracker = 1;
        for (let x = -8; x <= 8; x++) {
            if (x === 0) continue;
            f.sessions.receive(f.peer, f.request(tracker++, 'world', x));
        }

        for (let tick = 0; tick < 600; tick++) f.sessions.tick(f.peers, 45);

        expect(f.sessions.status()).toContain('0 pending LOD request(s)');
        expect(prepareCalls).toBe(16);
        expect(f.reads()).toBe(0);
        expect(f.ids().filter((id) => id === 6)).toHaveLength(16);
        expect(f.cache.has('world:0:0')).toBe(true);

        f.sent.length = 0;
        f.sessions.receive(f.peer, f.request(25));
        f.sessions.tick(f.peers, 45);

        expect(f.ids()).toEqual([10, 8]);
        expect(prepareCalls).toBe(16);
    });

    it('rejects a partially built section that becomes unavailable while sampling is suspended', () => {
        const f = fixture();
        f.settings.blocks_per_tick = 64;
        let available = true;
        f.peer.terrain.prepare = () =>
            available ? { status: 'ready' } : { status: 'unavailable', reason: 'Chunk became unloaded' };
        f.sessions.receive(f.peer, f.request());
        f.sessions.tick(f.peers, 0);
        expect(f.reads()).toBe(64);
        available = false;

        f.sessions.tick(f.peers, 45);

        expect(f.ids()).toContain(6);
        expect(f.reads()).toBe(64);
        expect(f.cache.has('world:0:0')).toBe(false);
        expect(f.sessions.status()).toContain('0 pending LOD request(s)');
    });

    it('runs forced captures at their fixed budget ahead of DH capture work', () => {
        const f = fixture();
        f.settings.blocks_per_tick = 64;
        f.peer.terrain.height = 16;
        f.sessions.receive(f.peer, f.request());

        expect(f.sessions.forceGenerate(f.peer, 32, 32)).toEqual({
            centerX: 0,
            centerZ: 0,
            radius: 0,
            sections: 1
        });
        f.sessions.tick(f.peers);
        expect(f.reads()).toBe(32768);
        expect(f.sessions.status()).toContain('Forced LOD capture for Alice: 50%');
        expect(f.sessions.status()).toContain('Forced budget up to 32768 block samples/tick');
        expect(f.sessions.status()).toContain('ordinary capture sampling paused');
        expect(f.reports.at(-1)).toContain('50%');

        f.sessions.tick(f.peers);
        expect(f.reads()).toBe(65536);
        expect(f.sessions.status()).not.toContain('Forced LOD capture');
        expect(f.reports.at(-1)).toContain('complete: 1 built, 0 skipped');

        f.sessions.tick(f.peers);
        expect(f.reads()).toBe(65536);
        expect(f.sessions.status()).toContain('1 served');
    });

    it('cancels forced work when its owner disconnects', () => {
        const f = fixture();
        f.peer.terrain.height = 16;
        f.sessions.forceGenerate(f.peer, 32, 32);
        f.sessions.tick(f.peers);
        f.sessions.playerLeft('Alice');
        f.sessions.tick(f.peers);

        expect(f.sessions.status()).not.toContain('Forced LOD capture');
        expect(f.reads()).toBe(32768);
    });

    it('keeps forced work running when only the DH protocol session closes', () => {
        const f = fixture();
        f.peer.terrain.height = 16;
        f.sessions.forceGenerate(f.peer, 32, 32);
        f.sessions.receive(f.peer, packet(1).string('client leaving').finish());

        expect(f.sessions.status()).toContain('Forced LOD capture for Alice');
        f.sessions.tick(f.peers);
        expect(f.reads()).toBe(32768);
    });

    it('checks unloaded sections before sampling and reports rejection instead of a static queue', () => {
        const f = fixture();
        f.peer.terrain.prepare = () => ({ status: 'unavailable', reason: 'Chunk 3, 3 is not loaded' });
        f.sessions.receive(f.peer, f.request());
        f.sessions.receive(f.peer, f.request(2));
        f.sessions.tick(f.peers);
        expect(f.reads()).toBe(0);
        expect(f.sessions.status()).toContain('0 pending');
        expect(f.sessions.status()).toContain('1 worker tick(s), 0 served, 2 rejected');
        expect(f.sessions.status()).toContain('Chunk 3, 3 is not loaded');
        f.sessions.tick(f.peers);
        expect(f.sessions.status()).toContain('0 pending');
        expect(f.ids()).toEqual([6, 6]);
    });
    it('waits for terrain preparation and retries before sampling', () => {
        const f = fixture();
        let attempts = 0;
        f.peer.terrain.prepare = () => {
            attempts++;
            return attempts === 1 ? { status: 'pending' } : { status: 'ready' };
        };

        f.sessions.receive(f.peer, f.request());
        f.sessions.tick(f.peers);
        expect(f.reads()).toBe(0);
        expect(f.sessions.status()).toContain('1 pending');

        f.sessions.tick(f.peers);
        expect(attempts).toBe(3);
        expect(f.reads()).toBe(4096);
        expect(f.sessions.status()).toContain('1 served');
    });
    it('rechecks loaded chunks before continuing a capture on the next tick', () => {
        const f = fixture();
        f.settings.blocks_per_tick = 64;
        let attempts = 0;
        f.peer.terrain.prepare = () =>
            ++attempts === 1 ? { status: 'ready' } : { status: 'unavailable', reason: 'Chunk unloaded' };

        f.sessions.receive(f.peer, f.request());
        f.sessions.tick(f.peers);
        expect(f.reads()).toBe(64);
        expect(f.sessions.status()).toContain('1 pending');

        f.sessions.tick(f.peers);
        expect(attempts).toBe(2);
        expect(f.reads()).toBe(64);
        expect(f.sessions.status()).toContain('0 pending');
        expect(f.sessions.status()).toContain('1 rejected');
    });
    it('rechecks loaded chunks before serving a completed capture', () => {
        const f = fixture();
        let attempts = 0;
        f.peer.terrain.prepare = () =>
            ++attempts === 1 ? { status: 'ready' } : { status: 'unavailable', reason: 'Chunk unloaded' };

        f.sessions.receive(f.peer, f.request());
        f.sessions.tick(f.peers);

        expect(attempts).toBe(2);
        expect(f.reads()).toBe(4096);
        expect(f.sessions.status()).toContain('0 pending');
        expect(f.sessions.status()).toContain('0 served, 1 rejected');
    });
    it('shows capture progress and distinguishes cancellations from completed work', () => {
        const f = fixture();
        f.settings.blocks_per_tick = 64;
        f.sessions.receive(f.peer, f.request());
        f.sessions.tick(f.peers);
        expect(f.sessions.status()).toContain('Capturing world 0, 0: 1.6%');
        f.sessions.receive(f.peer, packet(5).int(1).finish());
        expect(f.sessions.status()).toContain('1 cancelled');
        expect(f.sessions.status()).not.toContain('Capturing');
        f.settings.blocks_per_tick = 16384;
        f.sessions.receive(f.peer, f.request(2));
        f.sessions.tick(f.peers);
        expect(f.sessions.status()).toContain('1 served');
    });
    it('stops pending captures and drops queued transfers when the client disables LOD requests', () => {
        const disabled = packet(4)
            .byte(3)
            .int(16)
            .int(0)
            .int(0)
            .int(0)
            .int(0)
            .bool(false)
            .int(0)
            .bool(false)
            .int(16)
            .int(0)
            .int(0)
            .finish();

        const pending = fixture();
        pending.settings.blocks_per_tick = 64;
        pending.sessions.receive(pending.peer, pending.request());
        pending.sessions.tick(pending.peers);
        expect(pending.sessions.status()).toContain('1 pending');

        pending.sessions.receive(pending.peer, disabled);
        expect(pending.sessions.status()).toContain('0 pending');
        expect(pending.sessions.status()).not.toContain('Capturing');
        expect(pending.ids()).toContain(6);
        const readsAfterDisable = pending.reads();
        pending.sessions.tick(pending.peers);
        expect(pending.reads()).toBe(readsAfterDisable);

        pending.sent.length = 0;
        pending.sessions.receive(pending.peer, pending.request(2));
        expect(pending.ids()).toEqual([6]);
        expect(pending.sessions.status()).toContain('LOD requests disabled by client');

        const queued = fixture();
        queued.settings.cached_packets_per_tick = 0;
        queued.cache.put('world:0:0', { updated: 1000, data: new Uint8Array(64).fill(1) });
        queued.sessions.receive(queued.peer, queued.request());
        queued.sessions.tick(queued.peers);
        expect(queued.sessions.status()).not.toContain('0 queued packet(s)');

        queued.sessions.receive(queued.peer, disabled);
        expect(queued.sessions.status()).toContain('1 response(s)');
        queued.settings.cached_packets_per_tick = 16;
        queued.sessions.tick(queued.peers);
        expect(queued.sessions.status()).toContain('1 served');
    });
    it('drops a pending capture when a client closes its session', () => {
        const f = fixture();
        f.settings.blocks_per_tick = 64;
        f.sessions.receive(f.peer, f.request());
        f.sessions.tick(f.peers);
        expect(f.reads()).toBe(64);

        f.sessions.receive(f.peer, packet(1).string('client leaving').finish());
        f.sessions.tick(f.peers);

        expect(f.reads()).toBe(64);
        expect(f.sessions.status()).toContain('0 Distant Horizons client(s), 0 pending LOD request(s)');
    });
    it('drains two full-height captures at the default tick budget instead of scanning empty sky', () => {
        const f = fixture();
        f.settings.blocks_per_tick = 2048;
        f.settings.packets_per_tick = 2;
        f.peer.terrain = {
            minY: 0,
            height: 384,
            chunkLoader: unavailableChunkLoader,
            terrainGenerator: unavailableTerrainGenerator,
            prepare: () => ({ status: 'ready' as const }),
            top: () => 3,
            sample: (_x, y) => ({
                material: `minecraft:plains_DH-BSW_minecraft:${y > 3 ? 'air' : 'stone'}`,
                skyLight: 15,
                blockLight: 0
            })
        };
        f.sessions.receive(f.peer, f.request());
        f.sessions.receive(f.peer, f.request(2, 'world', 1));
        expect(f.sessions.status()).toContain('2 pending');
        for (let tick = 0; tick < 40; tick++) f.sessions.tick(f.peers);
        expect(f.sessions.status()).toContain('0 pending');
        expect(f.sessions.status()).toContain('2 served');
        expect(f.sessions.status()).toContain('0 queued packet(s)');
        expect(f.files.list('cache')).toHaveLength(2);
        expect(f.ids().filter((id) => id === 8)).toHaveLength(2);
    });
    it('scales capture work with server MSPT and the measured cost of block samples', () => {
        const times = [0, 0, 0, 0, 5, 5, 5, 5, 10, 10];
        const f = fixture(() => times.shift() ?? 10);
        f.settings.blocks_per_tick = 32768;
        let reads = 0;
        f.peer.terrain = {
            minY: 0,
            height: 10,
            chunkLoader: unavailableChunkLoader,
            terrainGenerator: unavailableTerrainGenerator,
            sample: () => {
                reads++;
                return { material: 'minecraft:plains_DH-BSW_minecraft:stone', skyLight: 15, blockLight: 0 };
            }
        };
        f.sessions.receive(f.peer, f.request());

        f.sessions.tick(f.peers, 45);
        expect(reads).toBe(0);
        expect(f.sessions.status()).toContain('Capture budget 0/32768');

        f.sessions.tick(f.peers, 0);
        expect(reads).toBe(8192);
        expect(f.sessions.status()).toContain('Capture budget 8192/32768');

        f.sessions.tick(f.peers, 0);
        expect(reads).toBe(40960);
        expect(f.sessions.status()).toContain('1 served');
        expect(f.sessions.status()).toContain('Capture budget 32768/32768');
    });
    it('captures loaded terrain, sends split data and reuses the persisted capture', () => {
        const f = fixture();
        f.sessions.receive(f.peer, f.request());
        f.sessions.tick(f.peers);
        expect(f.reads()).toBe(4096);
        expect(f.ids().at(-1)).toBe(8);
        expect(f.ids()).toContain(10);
        const diskCache = new LodCache(f.files, 0, f.settings.disk_cache_entries);
        const restarted = new Sessions(f.settings, diskCache, new MemoryLogger(), () => 1000);
        f.sent.length = 0;
        restarted.receive(f.peer, packet(3).string(f.peer.dimension).finish());
        f.sent.length = 0;
        restarted.receive(f.peer, f.request(2));
        restarted.tick(f.peers);
        expect(f.reads()).toBe(4096);
        expect(f.ids()).toContain(10);
        expect(f.ids().at(-1)).toBe(8);
        expect(f.files.list('cache')).toHaveLength(1);
    });
    it('logs the location when it sends a generated LOD to a DH client', () => {
        const f = fixture();
        f.sessions.receive(f.peer, f.request(17, 'world', 2));

        f.sessions.tick(f.peers);

        expect(
            f.log
                .of('debug')
                .join('\n')
                // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI color codes start with the ESC control character.
                .replace(/\u001b\[[0-9;]*m/g, '')
        ).toContain('Sent captured LOD to Alice for world section 2, 0 (origin 128, 0 blocks)');
    });
    it('drains disk-cached transfers within the separately configured fast budget', () => {
        const f = fixture();
        f.settings.packets_per_tick = 1;
        f.settings.cached_packets_per_tick = 5;
        const diskCache = new LodCache(f.files, 0, f.settings.disk_cache_entries);
        diskCache.put('world:0:0', { updated: 1000, data: new Uint8Array(90_001).fill(7) });
        const restarted = new Sessions(f.settings, diskCache, new MemoryLogger(), () => 1000);
        restarted.receive(f.peer, packet(3).string(f.peer.dimension).finish());
        f.sent.length = 0;

        restarted.receive(f.peer, f.request());
        restarted.tick(f.peers);

        expect(f.reads()).toBe(0);
        expect(f.ids()).toEqual([10, 10, 10, 10, 8]);
        expect(restarted.status()).toContain('0 queued packet(s)');
    });
    it('serves multiple cached LODs for one player in a tick within the cached packet budget', () => {
        const f = fixture();
        f.settings.cached_requests_per_tick = 2;
        f.settings.cached_packets_per_tick = 4;
        const diskCache = new LodCache(f.files, 0, f.settings.disk_cache_entries);
        diskCache.put('world:0:0', { updated: 1000, data: new Uint8Array(64).fill(1) });
        diskCache.put('world:1:0', { updated: 1000, data: new Uint8Array(64).fill(2) });
        const sessions = new Sessions(f.settings, diskCache, new MemoryLogger(), () => 1000);
        sessions.receive(f.peer, packet(3).string(f.peer.dimension).finish());
        f.sent.length = 0;

        sessions.receive(f.peer, f.request(1));
        sessions.receive(f.peer, f.request(2, 'world', 1));
        sessions.tick(f.peers);

        expect(f.reads()).toBe(0);
        expect(f.ids()).toEqual([10, 8, 10, 8]);
        expect(sessions.status()).toContain('2 served');
        expect(sessions.status()).toContain('0 pending LOD request(s)');
    });
    it('serves an expired cached LOD before refreshing it in the background', () => {
        const f = fixture();
        f.settings.refresh_seconds = 1;
        f.settings.blocks_per_tick = 16384;
        f.peer.terrain.height = 1;
        let chunksReady = false;
        f.peer.terrain.prepare = () => (chunksReady ? { status: 'ready' } : { status: 'pending' });
        const cache = new LodCache(f.files, 0, f.settings.disk_cache_entries);
        cache.put('world:0:0', { updated: 0, data: new Uint8Array(64).fill(1) });
        const sessions = new Sessions(f.settings, cache, new MemoryLogger(), () => 1000);
        sessions.receive(f.peer, packet(3).string(f.peer.dimension).finish());
        f.sent.length = 0;

        sessions.receive(f.peer, f.request());
        sessions.tick(f.peers);

        expect(f.ids()).toEqual([10, 8]);
        expect(f.reads()).toBe(0);

        chunksReady = true;
        sessions.tick(f.peers);

        expect(f.reads()).toBe(4096);
        expect(cache.get('world:0:0')?.updated).toBe(1000);
    });
    it('serves cached requests from multiple players in one tick within both configured limits', () => {
        const f = fixture();
        f.settings.cached_requests_per_tick = 2;
        f.settings.cached_packets_per_tick = 4;
        const diskCache = new LodCache(f.files, 0, f.settings.disk_cache_entries);
        diskCache.put('world:0:0', { updated: 1000, data: new Uint8Array(64).fill(1) });
        diskCache.put('world:1:0', { updated: 1000, data: new Uint8Array(64).fill(2) });
        diskCache.put('world:2:0', { updated: 1000, data: new Uint8Array(64).fill(3) });
        const sessions = new Sessions(f.settings, diskCache, new MemoryLogger(), () => 1000);
        const bobSent: Uint8Array[] = [];
        const bob: Peer = { ...f.peer, name: 'Bob', send: (bytes) => bobSent.push(bytes) };
        const carolSent: Uint8Array[] = [];
        const carol: Peer = { ...f.peer, name: 'Carol', send: (bytes) => carolSent.push(bytes) };
        const peers = {
            withPeer: (name: string, use: (peer: Peer) => void) => {
                const peer =
                    name === f.peer.name ? f.peer : name === bob.name ? bob : name === carol.name ? carol : undefined;
                if (!peer) return false;
                use(peer);
                return true;
            }
        };
        sessions.receive(f.peer, packet(3).string(f.peer.dimension).finish());
        sessions.receive(bob, packet(3).string(bob.dimension).finish());
        sessions.receive(carol, packet(3).string(carol.dimension).finish());
        f.sent.length = 0;
        bobSent.length = 0;
        carolSent.length = 0;

        sessions.receive(f.peer, f.request(1));
        sessions.receive(bob, f.request(2, 'world', 1));
        sessions.receive(carol, f.request(3, 'world', 2));
        sessions.tick(peers);

        const ids = (sent: Uint8Array[]) =>
            sent.map((bytes) => {
                const reader = new Reader(bytes);
                reader.short();
                return reader.short();
            });
        expect(f.reads()).toBe(0);
        expect(ids(f.sent)).toEqual([10, 8]);
        expect(ids(bobSent)).toEqual([10, 8]);
        expect(carolSent).toHaveLength(0);
        expect(sessions.status()).toContain('1 pending LOD request(s)');
        expect(sessions.status()).toContain('2 served');

        f.settings.cached_requests_per_tick = 3;
        sessions.tick(peers);

        expect(ids(carolSent)).toEqual([10, 8]);
        expect(sessions.status()).toContain('0 pending LOD request(s)');
        expect(sessions.status()).toContain('3 served');
    });
    it('falls back to a saved capture when an expired section is no longer loaded', () => {
        const f = fixture();
        f.sessions.receive(f.peer, f.request());
        f.sessions.tick(f.peers);
        f.sent.length = 0;
        f.settings.refresh_seconds = 0;
        f.peer.terrain.sample = () => {
            throw new Error('Chunk unloaded');
        };
        f.sessions.receive(f.peer, f.request(2));
        f.sessions.tick(f.peers);
        expect(f.ids()).toContain(10);
        expect(f.ids().at(-1)).toBe(8);
        expect(f.sessions.status()).toContain('0 pending');
    });
    it('rejects invalid requests and applies the combined queue capacity', () => {
        const f = fixture();
        f.sessions.receive(f.peer, f.request(1, 'other'));
        expect(f.ids()).toEqual([6]);
        f.sent.length = 0;
        f.sessions.receive(f.peer, f.request(2, 'world', 100));
        expect(f.ids()).toEqual([6]);
        f.peer.insideBorder = () => false;
        f.sessions.receive(f.peer, f.request(3));
        expect(f.ids()).toEqual([6, 6]);
        f.peer.insideBorder = () => true;
        f.sent.length = 0;
        f.settings.pending_requests = 2;
        f.sessions.receive(f.peer, f.request(4));
        f.sessions.receive(f.peer, f.request(5));
        f.sessions.receive(f.peer, f.request(6));
        expect(f.ids()).toEqual([6]);
        expect(f.sessions.status()).toContain('2 pending');
    });
    it('cancels requests, forgets disconnected clients and refuses unloaded terrain', () => {
        const f = fixture();
        f.sessions.receive(f.peer, f.request());
        f.sessions.receive(f.peer, packet(5).int(1).finish());
        f.sessions.tick(f.peers);
        expect(f.reads()).toBe(0);
        f.peer.terrain.sample = () => {
            throw new Error('Chunk unloaded');
        };
        f.sessions.receive(f.peer, f.request(2));
        f.sessions.tick(f.peers);
        expect(f.ids()).toEqual([6]);
        expect(f.files.list('cache')).toHaveLength(0);
        f.sessions.left('Alice');
        expect(f.sessions.status()).toContain('0 Distant Horizons client');
    });
    it('enforces work and transfer budgets and prevents obsolete captures after changes', () => {
        const f = fixture();
        f.settings.blocks_per_tick = 64;
        f.sessions.receive(f.peer, f.request());
        f.sessions.tick(f.peers);
        expect(f.reads()).toBe(64);
        expect(f.sent).toHaveLength(0);
        f.sessions.changed('world', 0, 0);
        f.sessions.tick(f.peers);
        expect(f.ids()).toEqual([6]);
        expect(f.files.list('cache')).toHaveLength(0);
        f.sent.length = 0;
        f.settings.blocks_per_tick = 16384;
        f.settings.packets_per_tick = 1;
        f.sessions.receive(f.peer, f.request(2));
        f.sessions.tick(f.peers);
        expect(f.sent).toHaveLength(1);
        f.sessions.receive(f.peer, f.request(3));
        expect(f.ids().at(-1)).toBe(10);
        expect(f.sessions.status()).toContain('1 pending LOD request(s)');
        for (let tick = 0; tick < 4; tick++) f.sessions.tick(f.peers);
        expect(f.sessions.status()).toContain('2 served');
    });
    it('resets pending requests on a world change and closes malformed sessions', () => {
        const f = fixture();
        f.sessions.receive(f.peer, f.request());
        f.peer.level = 'world_nether';
        f.peer.dimension = 'minecraft:the_nether';
        f.sessions.tick(f.peers);
        expect(f.ids()).toEqual([1, 2, 4]);
        expect(f.sessions.status()).toContain('0 pending');
        f.sent.length = 0;
        f.sessions.receive(f.peer, new Uint8Array([0]));
        expect(f.ids()).toEqual([1]);
        expect(f.sessions.status()).toContain('0 Distant Horizons client');
    });
});

function readFragment(bytes: Uint8Array): { buffer: number; data: Uint8Array; first: boolean } {
    const input = new Reader(bytes);
    input.short();
    if (input.short() !== 10) throw new Error('Expected a DH LOD fragment');
    const buffer = input.int();
    const length = input.int();
    const data = input.bytes(length);
    const first = input.bool();
    input.end();
    return { buffer, data, first };
}

function concat(chunks: Uint8Array[]): Uint8Array {
    const result = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return result;
}
