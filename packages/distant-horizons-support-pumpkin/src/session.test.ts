import { MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it } from 'vitest';
import { readSettings } from './config/load.ts';
import { LodCache } from './lod/cache.ts';
import { Reader } from './protocol/bytes.ts';
import { packet } from './protocol/messages.ts';
import { type Peer, Sessions } from './session.ts';

function fixture() {
    const files = new MemoryFiles(),
        log = new MemoryLogger();
    const settings = readSettings(files, log);
    settings.blocks_per_tick = 16384;
    settings.packets_per_tick = 16;
    const cache = new LodCache(files, settings.cache_entries),
        sessions = new Sessions(settings, cache, log, () => 1000);
    const sent: Uint8Array[] = [];
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
            sample: () => {
                reads++;
                return { mapping: 'minecraft:plains_DH-BSW_minecraft:stone', sky: 15, block: 0 };
            }
        },
        insideBorder: () => true,
        send: (bytes) => sent.push(bytes)
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
            .words(0, (x << 8) | 6)
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
    return { files, settings, sessions, peer, peers, sent, request, ids, reads: () => reads };
}
describe('DH sessions', () => {
    it('captures loaded terrain, sends split data and reuses the persisted capture', () => {
        const f = fixture();
        f.sessions.receive(f.peer, f.request());
        f.sessions.tick(f.peers);
        expect(f.reads()).toBe(4096);
        expect(f.ids().at(-1)).toBe(8);
        expect(f.ids()).toContain(10);
        f.sent.length = 0;
        f.sessions.receive(f.peer, f.request(2, 'world', 0, 1000));
        f.sessions.tick(f.peers);
        expect(f.reads()).toBe(4096);
        expect(f.ids()).toEqual([8]);
        expect(f.sent[0]?.at(-1)).toBe(0);
        expect(f.files.list('cache')).toHaveLength(1);
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
    it('rejects wrong worlds, distant terrain, borders and too many requests', () => {
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
        expect(f.sessions.status()).toContain('0 DH client');
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
        expect(f.ids().at(-1)).toBe(6);
    });
    it('resets pending requests on a world change and closes malformed sessions', () => {
        const f = fixture();
        f.sessions.receive(f.peer, f.request());
        f.peer.level = 'world_nether';
        f.peer.dimension = 'minecraft:the_nether';
        f.sessions.tick(f.peers);
        expect(f.ids()).toEqual([2, 4]);
        expect(f.sessions.status()).toContain('0 pending');
        f.sent.length = 0;
        f.sessions.receive(f.peer, new Uint8Array([0]));
        expect(f.ids()).toEqual([1]);
        expect(f.sessions.status()).toContain('0 DH client');
    });
});
