import { MemoryFiles } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it } from 'vitest';
import { Reader } from '../protocol/bytes.ts';
import { LodCache } from './cache.ts';

const lod = (updated: number) => ({ updated, data: new Uint8Array(100).fill(updated) });
describe('LOD cache', () => {
    it('does not rescan the disk directory when writing after startup', () => {
        class CountingFiles extends MemoryFiles {
            listCalls = 0;
            statCalls = 0;
            override list(directory: string): string[] {
                this.listCalls++;
                return super.list(directory);
            }
            override stat(path: string) {
                this.statCalls++;
                return super.stat(path);
            }
        }

        const files = new CountingFiles();
        const initial = new LodCache(files, 0, 1000);
        for (let index = 0; index < 128; index++) initial.put(`section-${index}`, lod(index));

        const restarted = new LodCache(files, 0, 1000);
        files.listCalls = 0;
        files.statCalls = 0;
        expect(restarted.get('missing-section')).toBeUndefined();
        expect(files.statCalls).toBe(0);

        restarted.put('one-more', lod(129));

        expect(files.listCalls).toBe(0);
        expect(files.statCalls).toBe(1);
        expect(restarted.stats().diskEntries).toBe(129);
    });

    it('backs up a selected legacy entry and its key before removal, preserving unrelated data across restart', () => {
        const files = new MemoryFiles();
        const cache = new LodCache(files, 8, 8);
        const suspectKey = 'world:4:-3';
        const unrelatedKey = 'world:5:-3';
        const legacyEmpty = new Uint8Array(64);
        const unrelated = new Uint8Array(64).fill(7);
        cache.put(suspectKey, { updated: 1234, data: legacyEmpty });
        cache.put(unrelatedKey, { updated: 2345, data: unrelated });
        const cacheName = files.list('cache').find((name) => {
            const reader = new Reader(files.readFile(`cache/${name}`));
            reader.int();
            return reader.string() === suspectKey;
        });
        if (!cacheName) throw new Error('Selected cache entry was not persisted');
        const original = files.readFile(`cache/${cacheName}`);

        const backup = cache.backupAndRemove(suspectKey);

        expect(backup).toMatchObject({ key: suspectKey });
        if (!backup) throw new Error('Selected cache entry was not backed up');
        expect(files.readFile(backup.dataPath)).toEqual(original);
        const manifest = new Reader(files.readFile(backup.manifestPath));
        expect(manifest.int()).toBe(0x44485231);
        expect(manifest.string()).toBe(suspectKey);
        expect(manifest.string()).toBe(backup.dataPath);
        manifest.end();

        const restarted = new LodCache(files, 8, 8);
        expect(restarted.get(suspectKey)).toBeUndefined();
        expect(restarted.get(unrelatedKey)?.data).toEqual(unrelated);
        expect(files.stat(backup.dataPath)?.kind).toBe('file');
        expect(files.stat(backup.manifestPath)?.kind).toBe('file');
    });

    it('preserves the selected cache entry when writing its backup manifest fails', () => {
        class FailingManifestFiles extends MemoryFiles {
            override writeFile(path: string, content: Uint8Array): void {
                if (path.endsWith('.dhm')) throw new Error('manifest write failed');
                super.writeFile(path, content);
            }
        }

        const files = new FailingManifestFiles();
        const cache = new LodCache(files, 2, 2);
        const key = 'world:2:-1';
        cache.put(key, { updated: 1234, data: new Uint8Array(64).fill(8) });

        expect(() => cache.backupAndRemove(key)).toThrow('manifest write failed');
        expect(cache.get(key)?.data).toEqual(new Uint8Array(64).fill(8));
        expect(files.list('cache-recovery')).toHaveLength(1);
    });

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
    it('checks whether a section is cached without reading or promoting disk entries', () => {
        const files = new MemoryFiles();
        const cache = new LodCache(files, 1, 2);
        cache.put('memory-and-disk', lod(1));
        cache.put('disk-only', lod(2));
        cache.clearMemory();

        expect(cache.has('memory-and-disk')).toBe(true);
        expect(cache.has('disk-only')).toBe(true);
        expect(cache.has('missing')).toBe(false);
        expect(cache.stats()).toMatchObject({ memoryEntries: 0, diskEntries: 2 });
        expect(files.reads.size).toBe(0);
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
