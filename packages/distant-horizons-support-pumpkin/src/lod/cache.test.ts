import { MemoryFiles } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it } from 'vitest';
import { LodCache } from './cache.ts';

const lod = (updated: number) => ({ updated, data: new Uint8Array(100).fill(updated) });
describe('LOD cache', () => {
    it('persists captures across restarts, uses bounded filenames and detects corruption', () => {
        const files = new MemoryFiles(),
            key = `${'w'.repeat(128)}:12:-4`;
        const cache = new LodCache(files, 2, 2);
        cache.put(key, lod(12));
        expect(new LodCache(files, 2, 2).get(key)).toEqual(lod(12));
        const name = files.list('cache')[0] ?? '';
        expect(name.length).toBeLessThan(255);
        const bytes = files.readFile(`cache/${name}`);
        bytes[bytes.length - 1] = 99;
        files.put(`cache/${name}`, bytes);
        expect(new LodCache(files, 2, 2).get(key)).toBeUndefined();
        expect(files.list('cache')).toHaveLength(0);
    });
    it('evicts old disk entries and removes invalidated captures', () => {
        const files = new MemoryFiles(),
            cache = new LodCache(files, 2, 2);
        cache.put('a', lod(1));
        cache.put('b', lod(2));
        cache.put('c', lod(3));
        expect(files.list('cache')).toHaveLength(2);
        expect(new LodCache(files, 2, 2).get('a')).toBeUndefined();
        cache.remove('b');
        expect(cache.get('b')).toBeUndefined();
        expect(files.list('cache')).toHaveLength(1);
    });
    it('applies independent memory and disk limits', () => {
        const files = new MemoryFiles(),
            cache = new LodCache(files, 1, 2);
        cache.put('a', lod(1));
        cache.put('b', lod(2));
        cache.put('c', lod(3));

        expect(cache.stats()).toMatchObject({ memoryEntries: 1, diskEntries: 2 });
        expect(cache.get('a')).toBeUndefined();
        expect(cache.get('b')).toEqual(lod(2));
    });
    it('supports disabled and unlimited tiers', () => {
        const files = new MemoryFiles();
        const disabled = new LodCache(files, 0, 0);
        disabled.put('discarded', lod(1));
        expect(disabled.stats()).toMatchObject({ memoryEntries: 0, diskEntries: 0 });
        expect(disabled.get('discarded')).toBeUndefined();

        const diskOnly = new LodCache(files, 0, 2);
        diskOnly.put('disk', lod(2));
        expect(diskOnly.stats()).toMatchObject({ memoryEntries: 0, diskEntries: 1 });
        expect(diskOnly.get('disk')).toEqual(lod(2));
        expect(diskOnly.stats().memoryEntries).toBe(0);

        const memoryOnly = new LodCache(files, 1, 0);
        memoryOnly.put('memory', lod(3));
        expect(memoryOnly.stats()).toMatchObject({ memoryEntries: 1, diskEntries: 0 });
        expect(memoryOnly.get('memory')).toEqual(lod(3));

        const unlimited = new LodCache(files, -2, -3);
        unlimited.put('a', lod(4));
        unlimited.put('b', lod(5));
        unlimited.put('c', lod(6));
        expect(unlimited.stats()).toMatchObject({ memoryEntries: 3, diskEntries: 3 });
    });
    it('clears memory and disk independently or together', () => {
        const files = new MemoryFiles(),
            cache = new LodCache(files, 2, 2);
        cache.put('a', lod(1));
        cache.put('b', lod(2));

        expect(cache.clearMemory()).toBe(2);
        expect(cache.stats()).toMatchObject({ memoryEntries: 0, diskEntries: 2 });
        expect(cache.clearDisk()).toBe(2);
        expect(cache.stats()).toMatchObject({ memoryEntries: 0, diskEntries: 0 });

        cache.put('c', lod(3));
        expect(cache.clear()).toEqual({ memoryEntries: 1, diskEntries: 1 });
        expect(cache.stats()).toMatchObject({ memoryEntries: 0, diskEntries: 0 });
    });
});
