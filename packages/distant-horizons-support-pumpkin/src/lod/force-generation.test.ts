import { MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { unavailableChunkLoader, unavailableTerrainGenerator } from '@pumpkin-plugins/terrain';
import { describe, expect, it } from 'vitest';
import { LodCache } from './cache.ts';
import { ForcedLodGeneration, type ForcedLodPeer, type ForcedLodPeers } from './force-generation.ts';

function fixture(height = 1) {
    const files = new MemoryFiles();
    const logger = new MemoryLogger();
    const cache = new LodCache(files, 128, 4096);
    const reports: string[] = [];
    let samples = 0;
    const peer: ForcedLodPeer = {
        name: 'Alice',
        level: 'world',
        terrain: {
            minY: 0,
            height,
            chunkLoader: unavailableChunkLoader,
            terrainGenerator: unavailableTerrainGenerator,
            sample: () => {
                samples++;
                return { material: 'minecraft:plains_DH-BSW_minecraft:stone', skyLight: 15, blockLight: 0 };
            }
        },
        insideBorder: () => true,
        report: (message) => reports.push(message)
    };
    const peers: ForcedLodPeers = {
        withPeer: (name, use) => {
            if (name !== peer.name) return false;
            use(peer);
            return true;
        }
    };
    const generation = new ForcedLodGeneration(cache, logger, () => 1234);
    return { cache, generation, logger, peer, peers, reports, samples: () => samples };
}

describe('forced LOD generation', () => {
    it('captures and caches a section without a DH client request', () => {
        const f = fixture();
        const started = f.generation.start(f.peer, 32, 32);

        expect(started).toEqual({ centerX: 0, centerZ: 0, radius: 0, sections: 1, skippedOutsideBorder: 0 });
        expect(f.generation.tick(f.peers)).toBe(true);
        expect(f.generation.status()).toBeUndefined();
        expect(f.cache.get('world:0:0')?.updated).toBe(1234);
        expect(f.samples()).toBe(4096);
        expect(f.reports.at(-1)).toContain('complete: 1 built, 0 skipped');
    });

    it('uses the full forced-work budget and reports partial progress during a capture', () => {
        const f = fixture(16);
        f.generation.start(f.peer, 32, 32);

        f.generation.tick(f.peers);

        expect(f.samples()).toBe(32_768);
        expect(f.generation.status()).toContain('50%');
        expect(f.reports.at(-1)).toContain('50%');

        f.generation.tick(f.peers);
        expect(f.samples()).toBe(65_536);
        expect(f.cache.has('world:0:0')).toBe(true);
        expect(f.reports.at(-1)).toContain('complete: 1 built, 0 skipped');
    });

    it('skips sections whose chunks are unavailable and reports the final count', () => {
        const f = fixture();
        f.peer.terrain.prepare = () => ({ status: 'unavailable', reason: 'Chunk is not loaded' });
        f.generation.start(f.peer, 32, 32);

        f.generation.tick(f.peers);

        expect(f.samples()).toBe(0);
        expect(f.cache.has('world:0:0')).toBe(false);
        expect(f.generation.status()).toBeUndefined();
        expect(f.reports.at(-1)).toContain('complete: 0 built, 1 skipped');
    });

    it('counts sections outside the world border once and builds the in-border sections', () => {
        const f = fixture();
        f.peer.insideBorder = (x, z) => x >= 0 && z >= 0;
        const started = f.generation.start(f.peer, 32, 32, 1);

        expect(started.skippedOutsideBorder).toBe(5);
        f.generation.tick(f.peers);

        expect(f.cache.has('world:0:0')).toBe(true);
        expect(f.cache.has('world:1:1')).toBe(true);
        expect(f.cache.stats().memoryEntries).toBe(4);
        expect(f.reports.at(-1)).toContain('complete: 4 built, 5 skipped');
    });

    it('rejects overlapping jobs and refuses to start when both cache tiers are disabled', () => {
        const f = fixture();
        f.generation.start(f.peer, 32, 32);
        expect(() => f.generation.start(f.peer, 32, 32)).toThrow('already running');

        const files = new MemoryFiles();
        const noCache = new ForcedLodGeneration(new LodCache(files, 0, 0), new MemoryLogger());
        expect(() => noCache.start(f.peer, 32, 32)).toThrow('Both LOD cache tiers are disabled');
    });
});
