import { MemoryFiles } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it } from 'vitest';
import { LodCache } from './cache.ts';

const lod = (updated: number) => ({ updated, data: new Uint8Array(100).fill(updated) });
describe('LOD cache', () => {
    it('persists captures across restarts, uses bounded filenames and detects corruption', () => {
        const files = new MemoryFiles(),
            key = `${'w'.repeat(128)}:12:-4`;
        const cache = new LodCache(files, 2);
        cache.put(key, lod(12));
        expect(new LodCache(files, 2).get(key)).toEqual(lod(12));
        const name = files.list('cache')[0] ?? '';
        expect(name.length).toBeLessThan(255);
        const bytes = files.readFile(`cache/${name}`);
        bytes[bytes.length - 1] = 99;
        files.put(`cache/${name}`, bytes);
        expect(new LodCache(files, 2).get(key)).toBeUndefined();
        expect(files.list('cache')).toHaveLength(0);
    });
    it('evicts old disk entries and removes invalidated captures', () => {
        const files = new MemoryFiles(),
            cache = new LodCache(files, 2);
        cache.put('a', lod(1));
        cache.put('b', lod(2));
        cache.put('c', lod(3));
        expect(files.list('cache')).toHaveLength(2);
        expect(new LodCache(files, 2).get('a')).toBeUndefined();
        cache.remove('b');
        expect(cache.get('b')).toBeUndefined();
        expect(files.list('cache')).toHaveLength(1);
    });
});
