import { MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it, vi } from 'vitest';
import { LodCache } from './cache.ts';
import { ForcedLodGeneration, type ForcedLodPeer, type ForcedLodPeers } from './force-generation.ts';

function fixture(height = 1) {
    const files = new MemoryFiles();
    const logger = new MemoryLogger();
    const cache = new LodCache(files, 128, 4096);
    const reports: string[] = [];
    let samples = 0;
    // The forced-work budget adapts to how long samples take. A fake clock where each sample costs
    // 1 µs keeps that cost the same on a fast or a loaded machine.
    let clock = 0;
    const peer: ForcedLodPeer = {
        name: 'Alice',
        level: 'world',
        terrain: {
            minY: 0,
            height,
            sample: () => {
                samples++;
                clock += 0.001;
                return { material: 'minecraft:plains_DH-BSW_minecraft:stone', skyLight: 15, blockLight: 0 };
            },
        },
        borderBounds: { minX: -1_000_000, maxX: 1_000_000, minZ: -1_000_000, maxZ: 1_000_000 },
        insideBorder: () => true,
        report: (message) => reports.push(message),
    };
    const peers: ForcedLodPeers = {
        withPeer: (name, use) => {
            if (name !== peer.name) return false;
            use(peer);
            return true;
        },
    };
    const generation = new ForcedLodGeneration(
        cache,
        logger,
        () => 1234,
        () => clock,
    );
    return { files, cache, generation, logger, peer, peers, reports, samples: () => samples };
}

describe('forced LOD generation', () => {
    it('captures and caches a section without a DH client request', () => {
        const f = fixture();
        const started = f.generation.start(f.peer, 32, 32);

        expect(started).toEqual({
            centerX: 0,
            centerZ: 0,
            radius: 0,
            sections: 1,
        });
        expect(f.generation.tick(f.peers)).toBe(true);
        expect(f.generation.status()).toBeUndefined();
        expect(f.cache.get('world:0:0')?.updated).toBe(1234);
        expect(f.samples()).toBe(4096);
        expect(f.reports.at(-1)).toContain('complete: 1 built, 0 skipped');
        expect(
            f.logger
                .of('debug')
                .join('\n')
                // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI color codes start with the ESC control character.
                .replace(/\u001b\[[0-9;]*m/g, ''),
        ).toContain('Built forced LOD for Alice at world section 0, 0 (origin 0, 0 blocks)');
        for (const line of f.logger.of('info')) {
            // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI color codes start with the ESC control character.
            expect(line).toMatch(/\u001b\[[0-9;]*mAlice/);
        }
        expect(f.logger.of('info')).toHaveLength(2);
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

    it('pauses forced sampling while the server has no spare tick time', () => {
        const f = fixture();
        f.generation.start(f.peer, 32, 32);

        f.generation.tick(f.peers, 46);
        expect(f.samples()).toBe(0);
        expect(f.cache.has('world:0:0')).toBe(false);

        f.generation.tick(f.peers, 10);
        expect(f.cache.has('world:0:0')).toBe(true);
    });

    it('scales forced sampling to the measured cost of a sample', () => {
        const f = fixture(16);
        let clock = 0;
        const sample = f.peer.terrain.sample;
        f.peer.terrain.sample = (x, y, z) => {
            clock += 0.01;
            return sample(x, y, z);
        };
        const generation = new ForcedLodGeneration(
            f.cache,
            f.logger,
            () => 1234,
            () => clock,
        );
        generation.start(f.peer, 32, 32);

        generation.tick(f.peers);
        expect(f.samples()).toBe(32_768);
        generation.tick(f.peers);
        expect(f.samples() - 32_768).toBeLessThan(5_000);
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

    it('bounds terrain preparation calls per tick during a large forced scan', () => {
        const f = fixture();
        const prepare = vi.fn(() => ({ status: 'unavailable' as const, reason: 'Chunk is not loaded' }));
        f.peer.terrain.prepare = prepare;
        f.generation.start(f.peer, 32, 32, 2);

        for (const expectedCalls of [8, 8, 8, 1]) {
            prepare.mockClear();
            f.generation.tick(f.peers);
            expect(prepare).toHaveBeenCalledTimes(expectedCalls);
        }

        expect(f.generation.status()).toBeUndefined();
        expect(f.reports.at(-1)).toContain('complete: 0 built, 25 skipped');
    });

    it('skips sections already in the LOD cache while generating the remaining sections', () => {
        const f = fixture();
        f.cache.put('world:0:0', { updated: 1, data: new Uint8Array(64) });

        const started = f.generation.start(f.peer, 32, 32, 1);
        f.generation.tick(f.peers);

        expect(started).toMatchObject({ sections: 9 });
        expect(f.cache.stats().memoryEntries).toBe(9);
        expect(f.samples()).toBe(8 * 4096);
        expect(f.reports.at(-1)).toContain('complete: 8 built, 1 skipped (1 already generated)');
    });

    it('skips a section whose cache entry cannot be read and keeps generating the others', () => {
        const f = fixture();
        f.cache.put('world:0:0', { updated: 1, data: new Uint8Array(64) });
        f.cache.clearMemory();
        const [unreadable] = f.files.list('cache');
        const stat = f.files.stat.bind(f.files);
        vi.spyOn(f.files, 'stat').mockImplementation((path) => {
            if (path === `cache/${unreadable}`) throw new Error('stat failed');
            return stat(path);
        });

        f.generation.start(f.peer, 32, 32, 1);
        f.generation.tick(f.peers);

        expect(f.generation.status()).toBeUndefined();
        expect(f.reports.at(-1)).toContain('complete: 8 built, 1 skipped (0 already generated)');
    });

    it('reports an entirely cached selection after worker verification', () => {
        const f = fixture();
        f.cache.put('world:0:0', { updated: 1, data: new Uint8Array(64) });

        f.generation.start(f.peer, 32, 32);
        expect(f.reports).toEqual([]);
        f.generation.tick(f.peers);
        expect(f.reports.at(-1)).toBe('All requested LOD sections are already generated.');
        expect(f.generation.status()).toBeUndefined();
        expect(f.samples()).toBe(0);
    });

    it('verifies a 3969-section disk selection incrementally without reading blobs during admission', () => {
        const f = fixture();
        for (let x = -31; x <= 31; x++) {
            for (let z = -31; z <= 31; z++) f.cache.put(`world:${x}:${z}`, { updated: 1, data: new Uint8Array(64) });
        }
        f.cache.clearMemory();
        const read = vi.spyOn(f.files, 'readFile');
        const get = vi.spyOn(f.cache, 'get');

        f.generation.start(f.peer, 32, 32, 31);

        expect(read).not.toHaveBeenCalled();
        expect(get).not.toHaveBeenCalled();
        expect(f.reports).toEqual([]);
        for (let tick = 0; tick < 63; tick++) {
            get.mockClear();
            read.mockClear();
            f.generation.tick(f.peers);
            expect(get.mock.calls.length).toBeLessThanOrEqual(64);
            expect(read.mock.calls.length).toBeLessThanOrEqual(64);
            if (tick < 62) {
                expect(f.generation.status()).toBeDefined();
                expect(f.reports).not.toContain('All requested LOD sections are already generated.');
            }
        }
        expect(f.generation.status()).toBeUndefined();
        expect(f.reports.at(-1)).toBe('All requested LOD sections are already generated.');
        expect(f.samples()).toBe(0);
    });

    it.each(['disconnect', 'world change'])('cancels cache verification on %s without further disk reads', (reason) => {
        const f = fixture();
        for (let x = -8; x <= 8; x++) {
            for (let z = -8; z <= 8; z++) f.cache.put(`world:${x}:${z}`, { updated: 1, data: new Uint8Array(64) });
        }
        f.cache.clearMemory();
        const read = vi.spyOn(f.files, 'readFile');
        f.generation.start(f.peer, 32, 32, 8);
        expect(read).not.toHaveBeenCalled();
        f.generation.tick(f.peers);
        expect(read).toHaveBeenCalledTimes(64);
        read.mockClear();
        if (reason === 'disconnect') f.generation.left(f.peer.name);
        else f.peer.level = 'other-world';
        f.generation.tick(f.peers);
        expect(read).not.toHaveBeenCalled();
        expect(f.generation.status()).toBeUndefined();
        expect(f.reports).not.toContain('All requested LOD sections are already generated.');
        expect(f.samples()).toBe(0);
    });

    it('accepts the maximum radius without materializing its section list', () => {
        const f = fixture();

        const started = f.generation.start(f.peer, 32, 32, 31);

        expect(started.sections).toBe(3969);
        expect(f.generation.status()).toContain('of 3969');
        f.generation.left(f.peer.name);
    });

    it('rejects a request above the section limit before considering the world border', () => {
        const f = fixture();
        f.peer.borderBounds = { minX: 0.5, maxX: 63.5, minZ: 0.5, maxZ: 63.5 };

        expect(() => f.generation.start(f.peer, 32, 32, 32)).toThrow(/4096/);
        expect(f.generation.status()).toBeUndefined();
        expect(f.reports).toEqual([]);
    });

    it('rejects a very large radius before calculating the selected area', () => {
        const f = fixture();

        expect(() => f.generation.start(f.peer, 32, 32, Number.MAX_SAFE_INTEGER)).toThrow(/4096/);
        expect(f.generation.status()).toBeUndefined();
    });

    it('verifies the only cached in-border section of a maximum-radius selection on its first tick', () => {
        const f = fixture();
        f.peer.borderBounds = { minX: 0.5, maxX: 63.5, minZ: 0.5, maxZ: 63.5 };
        f.peer.insideBorder = (x, z) => x >= 0 && x < 64 && z >= 0 && z < 64;
        f.cache.put('world:0:0', { updated: 1, data: new Uint8Array(64) });

        f.generation.start(f.peer, 32, 32, 31);
        f.generation.tick(f.peers);
        expect(f.generation.status()).toBeUndefined();
        expect(f.reports.at(-1)).toBe('All requested LOD sections are already generated.');
    });

    it('finishes a maximum-radius request after visiting its single in-border section', () => {
        const f = fixture();
        f.peer.borderBounds = { minX: 0.5, maxX: 63.5, minZ: 0.5, maxZ: 63.5 };
        f.peer.insideBorder = (x, z) => x >= 0 && x < 64 && z >= 0 && z < 64;

        f.generation.start(f.peer, 32, 32, 31);
        f.generation.tick(f.peers);

        expect(f.cache.has('world:0:0')).toBe(true);
        expect(f.generation.status()).toBeUndefined();
        expect(f.samples()).toBe(4096);
        expect(f.reports.at(-1)).toContain('complete: 1 built, 3968 skipped');
    });

    it('rebuilds corrupt persisted entries instead of treating them as generated', () => {
        const f = fixture();
        f.cache.put('world:0:0', { updated: 1, data: new Uint8Array(64).fill(7) });
        f.cache.put('world:1:0', { updated: 1, data: new Uint8Array(64).fill(9) });
        const file = f.files.list('cache').find((name) => f.files.readFile(`cache/${name}`).at(-1) === 7);
        if (!file) throw new Error('Missing persisted test LOD');
        const path = `cache/${file}`;
        const corrupted = f.files.readFile(path);
        corrupted[corrupted.length - 1] = 8;
        f.files.put(path, corrupted);
        f.cache.clearMemory();
        f.peer.borderBounds = { minX: -63.5, maxX: 127.5, minZ: 0.5, maxZ: 63.5 };

        const read = vi.spyOn(f.files, 'readFile');
        expect(() => f.generation.start(f.peer, 32, 32, 1)).not.toThrow();
        expect(read).not.toHaveBeenCalled();
        expect(f.cache.has('world:0:0')).toBe(true);
        f.generation.tick(f.peers);

        expect(f.cache.get('world:0:0')?.updated).toBe(1234);
        expect(f.samples()).toBe(8192);
    });

    it('backs up and rebuilds one selected checksum-valid legacy empty capture', () => {
        const f = fixture();
        const suspect = new Uint8Array(64);
        const unrelated = new Uint8Array(64).fill(9);
        f.cache.put('world:0:0', { updated: 1, data: suspect });
        f.cache.put('world:1:0', { updated: 2, data: unrelated });
        f.peer.terrain.prepare = () => ({ status: 'ready' });
        expect(f.cache.get('world:0:0')?.data).toEqual(suspect);

        const recovery = f.generation.recover(f.peer, 32, 32);

        expect(recovery.start.sections).toBe(1);
        expect(recovery.backup.key).toBe('world:0:0');
        expect(f.cache.get('world:0:0')).toBeUndefined();
        expect(f.cache.get('world:1:0')?.data).toEqual(unrelated);
        f.generation.tick(f.peers);

        expect(f.cache.get('world:0:0')?.updated).toBe(1234);
        expect(f.cache.get('world:0:0')?.data).not.toEqual(suspect);
        expect(f.cache.get('world:1:0')?.data).toEqual(unrelated);
        expect(f.files.stat(recovery.backup.dataPath)?.kind).toBe('file');
        expect(f.files.stat(recovery.backup.manifestPath)?.kind).toBe('file');
    });

    it('defers selected cache recovery until terrain is loaded without removing the entry', () => {
        const f = fixture();
        const suspect = new Uint8Array(64).fill(3);
        const unrelated = new Uint8Array(64).fill(9);
        f.cache.put('world:0:0', { updated: 1, data: suspect });
        f.cache.put('world:1:0', { updated: 2, data: unrelated });
        f.peer.terrain.prepare = () => ({ status: 'unavailable', reason: 'Chunk 0, 0 is not loaded' });

        expect(() => f.generation.recover(f.peer, 32, 32)).toThrow(
            'recovery deferred until all section chunks are loaded',
        );

        expect(f.cache.get('world:0:0')?.data).toEqual(suspect);
        expect(f.cache.get('world:1:0')?.data).toEqual(unrelated);
        expect(f.files.stat('cache-recovery')).toBeUndefined();
        expect(f.generation.status()).toBeUndefined();
    });

    it('counts sections outside the world border once and builds the in-border sections', () => {
        const f = fixture();
        f.peer.insideBorder = (x, z) => x >= 0 && z >= 0;
        f.peer.borderBounds = { minX: 0.5, maxX: 1_000_000, minZ: 0.5, maxZ: 1_000_000 };
        const started = f.generation.start(f.peer, 32, 32, 1);

        expect(started.sections).toBe(9);
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
