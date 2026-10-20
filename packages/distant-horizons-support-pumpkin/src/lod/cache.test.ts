import { MemoryFiles } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it } from 'vitest';
import { Reader } from '../protocol/bytes.ts';
import { LodCache } from './cache.ts';

const lod = (updated: number) => ({ updated, data: new Uint8Array(100).fill(updated) });
const oversizedCacheFile = new Uint8Array(16 * 1024 * 1024 + 1);

class TrackingFiles extends MemoryFiles {
    readonly openedPaths: string[] = [];

    override open(path: string) {
        this.openedPaths.push(path);
        return super.open(path);
    }
}

class ShortReadFiles extends MemoryFiles {
    readonly writes: string[] = [];

    override open(path: string) {
        const file = super.open(path);
        let returnedPrefix = false;
        return {
            size: file.size,
            read(offset: number, length: number): Uint8Array {
                if (returnedPrefix) return new Uint8Array();
                returnedPrefix = true;
                return file.read(offset, Math.min(length, 8));
            },
            close: () => file.close(),
        };
    }

    override writeFile(path: string, content: Uint8Array): void {
        this.writes.push(path);
        super.writeFile(path, content);
    }
}

function onlyCachePath(files: MemoryFiles): string {
    const name = files.list('cache')[0];
    if (!name) throw new Error('Expected one cached entry');
    return `cache/${name}`;
}

describe('LOD cache', () => {
    it('restores a disk-only entry whose encoded file reaches the size limit', () => {
        const files = new MemoryFiles();
        const key = 'world:🌍';
        const maxPayloadBytes = 16 * 1024 * 1024 - 22 - 10;
        const data = new Uint8Array(maxPayloadBytes).fill(42);

        new LodCache(files, 0, 1).put(key, { updated: 1234, data });

        const name = files.list('cache')[0];
        if (!name) throw new Error('Expected the cache entry to be persisted');
        const path = `cache/${name}`;
        expect(files.stat(path)?.size).toBe(16 * 1024 * 1024);

        const restored = new LodCache(files, 0, 1).get(key);
        expect(restored?.updated).toBe(1234);
        expect(restored?.data).toHaveLength(maxPayloadBytes);
        expect(restored?.data[0]).toBe(42);
        expect(restored?.data.at(-1)).toBe(42);
    }, 15_000);

    it('rejects one byte over the encoded file limit before writing or caching it', () => {
        class WriteTrackingFiles extends MemoryFiles {
            writeCount = 0;

            override writeFile(path: string, content: Uint8Array): void {
                this.writeCount++;
                super.writeFile(path, content);
            }
        }

        const files = new WriteTrackingFiles();
        const cache = new LodCache(files, 1, 1);
        const key = 'world:🌍';
        const maxPayloadBytes = 16 * 1024 * 1024 - 22 - 10;

        expect(() => cache.put(key, { updated: 1234, data: new Uint8Array(maxPayloadBytes + 1) })).toThrow(
            'LOD exceeds cache size limit',
        );
        expect(files.writeCount).toBe(0);
        expect(cache.stats()).toMatchObject({ memoryEntries: 0, diskEntries: 0 });
    });

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

    it('preserves the source when a disk backup read reaches EOF before the reported size', () => {
        const files = new ShortReadFiles();
        const key = 'world:short-read';
        new LodCache(files, 0, 2).put(key, lod(1));
        const cachePath = onlyCachePath(files);
        files.writes.length = 0;
        const cache = new LodCache(files, 0, 2);

        expect(cache.backupAndRemove(key)).toBeUndefined();

        expect(files.writes).toEqual([]);
        expect(files.stat(cachePath)?.kind).toBe('file');
        expect(cache.has(key)).toBe(true);
        expect(files.stat('cache-recovery')).toBeUndefined();
    });

    it('preserves an indexed oversized disk recovery entry without reading or backing it up', () => {
        const files = new TrackingFiles();
        const key = 'world:oversized-indexed';
        new LodCache(files, 0, 2).put(key, lod(1));
        const cachePath = onlyCachePath(files);
        files.put(cachePath, oversizedCacheFile);

        const cache = new LodCache(files, 0, 2);
        files.reads.clear();
        files.openedPaths.length = 0;

        expect(cache.backupAndRemove(key)).toBeUndefined();
        expect(files.reads.get(cachePath) ?? 0).toBe(0);
        expect(files.openedPaths).toEqual([]);
        expect(cache.has(key)).toBe(true);
        expect(cache.stats()).toMatchObject({ diskEntries: 1 });
        expect(files.stat(cachePath)?.size).toBe(oversizedCacheFile.length);
        expect(files.stat('cache-recovery')).toBeUndefined();
    });

    it('checks the opened file size when the disk index is stale', () => {
        const files = new TrackingFiles();
        const key = 'world:oversized-after-index';
        const cache = new LodCache(files, 0, 2);
        cache.put(key, lod(1));
        const cachePath = onlyCachePath(files);
        files.put(cachePath, oversizedCacheFile);
        files.reads.clear();
        files.openedPaths.length = 0;

        expect(cache.backupAndRemove(key)).toBeUndefined();
        expect(files.openedPaths).toEqual([cachePath]);
        expect(files.reads.get(cachePath) ?? 0).toBe(0);
        expect(cache.has(key)).toBe(true);
        expect(cache.stats()).toMatchObject({ diskEntries: 1 });
        expect(files.stat(cachePath)?.size).toBe(oversizedCacheFile.length);
        expect(files.stat('cache-recovery')).toBeUndefined();
    });

    it('backs up from memory without reading an oversized disk copy', () => {
        const files = new TrackingFiles();
        const cache = new LodCache(files, 1, 2);
        const key = 'world:memory-backed-recovery';
        cache.put(key, lod(1));
        const cachePath = onlyCachePath(files);
        const expectedBackup = files.readFile(cachePath);
        files.put(cachePath, oversizedCacheFile);
        files.reads.clear();
        files.openedPaths.length = 0;

        const backup = cache.backupAndRemove(key);

        expect(backup).toMatchObject({ key });
        if (!backup) throw new Error('Selected cache entry was not backed up');
        expect(files.reads.get(cachePath) ?? 0).toBe(0);
        expect(files.openedPaths).toEqual([]);
        expect(files.readFile(backup.dataPath)).toEqual(expectedBackup);
        expect(cache.has(key)).toBe(false);
        expect(files.stat(cachePath)).toBeUndefined();
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
    it('deletes temporary files left by an interrupted write on startup', () => {
        const files = new MemoryFiles();
        new LodCache(files, 0, 2).put('kept', lod(1));
        const name = files.list('cache')[0] ?? '';
        files.put(`cache/${name}.tmp.0`, new Uint8Array(10));
        files.put('cache/0123abcd.lod.tmp.17', new Uint8Array(10));
        files.put('cache/notes.txt', new Uint8Array(1));

        const cache = new LodCache(files, 0, 2);

        expect(files.list('cache').sort()).toEqual([name, 'notes.txt'].sort());
        expect(cache.get('kept')).toEqual(lod(1));
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
    it('evicts the oldest memory entries above the byte budget', () => {
        const files = new MemoryFiles(),
            cache = new LodCache(files, -1, 0, 250);
        cache.put('a', lod(1));
        cache.put('b', lod(2));
        cache.get('a');
        cache.put('c', lod(3));

        expect(cache.stats()).toMatchObject({ memoryEntries: 2, memoryBytes: 200, memoryByteLimit: 250 });
        expect(cache.get('b')).toBeUndefined();
        expect(cache.get('a')).toEqual(lod(1));
        expect(cache.get('c')).toEqual(lod(3));

        cache.remove('a');
        cache.clearMemory();
        expect(cache.stats()).toMatchObject({ memoryEntries: 0, memoryBytes: 0 });
    });
    it('keeps an entry larger than the byte budget only on disk', () => {
        const files = new MemoryFiles(),
            cache = new LodCache(files, -1, 2, 150);
        cache.put('small', lod(1));
        const large = { updated: 2, data: new Uint8Array(200).fill(2) };
        cache.put('large', large);

        expect(cache.stats()).toMatchObject({ memoryEntries: 1, memoryBytes: 100, diskEntries: 2 });
        expect(cache.get('large')).toEqual(large);
        expect(cache.stats()).toMatchObject({ memoryEntries: 1, memoryBytes: 100 });
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
