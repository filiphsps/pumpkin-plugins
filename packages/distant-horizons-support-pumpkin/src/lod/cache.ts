import type { DataFiles } from '@pumpkin-plugins/plugin-kit/files';
import { Reader, Writer } from '../protocol/bytes.ts';

/** Last captured terrain data and its server timestamp. */
export interface CachedLod {
    data: Uint8Array;
    updated: number;
}
/** Entry counts and stored bytes for both cache tiers. */
export interface LodCacheStats {
    memoryEntries: number;
    memoryBytes: number;
    memoryLimit: number;
    diskEntries: number;
    diskBytes: number;
    diskLimit: number;
}
/** Persistent bounded cache; corrupt entries are discarded and rebuilt when terrain is available. */
export class LodCache {
    private readonly memory = new Map<string, CachedLod>();
    constructor(
        private readonly files: DataFiles,
        private readonly memoryLimit: number,
        private readonly diskLimit: number
    ) {
        files.createDirectory('cache');
        this.pruneDisk();
    }
    /** Checks for a stored capture without reading it into memory or changing its cache order. */
    has(key: string): boolean {
        if (this.memory.has(key)) return true;
        if (this.diskLimit === 0) return false;
        return this.files.stat(this.path(key))?.kind === 'file';
    }
    /** Looks up a captured section, without allocating for oversized or corrupt files. */
    get(key: string): CachedLod | undefined {
        let value = this.memory.get(key);
        if (!value) {
            if (this.diskLimit === 0) return undefined;
            const path = this.path(key);
            const stat = this.files.stat(path);
            if (!stat) return undefined;
            try {
                if (stat.kind !== 'file' || stat.size > 16 * 1024 * 1024) throw new Error('Invalid cached LOD');
                const input = new Reader(this.files.readFile(path));
                if (input.int() !== 0x44485031) throw new Error('Invalid cache format');
                if (input.string() !== key) throw new Error('Cache key mismatch');
                const expected = input.int() >>> 0;
                const updated = input.timestamp();
                const data = input.bytes(input.int());
                input.end();
                if (checksum(data) !== expected || data.length < 64) throw new Error('Invalid cached payload');
                value = { updated, data };
            } catch {
                this.files.remove(path);
                return undefined;
            }
        }
        if (this.memoryLimit !== 0) {
            this.memory.delete(key);
            this.memory.set(key, value);
            this.trimMemory();
        }
        return value;
    }
    /** Saves a complete capture atomically and evicts entries above their respective limits. */
    put(key: string, value: CachedLod): void {
        if (value.data.length > 16 * 1024 * 1024) throw new Error('LOD exceeds cache size limit');
        if (this.diskLimit !== 0)
            this.files.writeFile(
                this.path(key),
                new Writer()
                    .int(0x44485031)
                    .string(key)
                    .int(checksum(value.data))
                    .timestamp(value.updated)
                    .blob(value.data)
                    .finish()
            );
        if (this.memoryLimit !== 0) {
            this.memory.delete(key);
            this.memory.set(key, value);
        } else {
            this.memory.delete(key);
        }
        this.trimMemory();
        this.pruneDisk();
    }
    /** Invalidates a section affected by a known world change. */
    remove(key: string): void {
        this.memory.delete(key);
        const path = this.path(key);
        if (this.files.stat(path)) this.files.remove(path);
    }
    /** Returns cache usage without reading or decoding disk entries. */
    stats(): LodCacheStats {
        let memoryBytes = 0;
        for (const value of this.memory.values()) memoryBytes += value.data.length;
        const disk = this.diskFiles().reduce(
            (total, entry) => ({ entries: total.entries + 1, bytes: total.bytes + entry.size }),
            { entries: 0, bytes: 0 }
        );
        return {
            memoryEntries: this.memory.size,
            memoryBytes,
            memoryLimit: this.memoryLimit,
            diskEntries: disk.entries,
            diskBytes: disk.bytes,
            diskLimit: this.diskLimit
        };
    }
    /** Drops every in-memory entry and returns how many were removed. */
    clearMemory(): number {
        const removed = this.memory.size;
        this.memory.clear();
        return removed;
    }
    /** Drops every persisted LOD file and returns how many were removed. */
    clearDisk(): number {
        const entries = this.diskFiles();
        for (const entry of entries) this.files.remove(`cache/${entry.name}`);
        return entries.length;
    }
    /** Drops both cache tiers and reports how many entries were removed from each. */
    clear(): { memoryEntries: number; diskEntries: number } {
        return { memoryEntries: this.clearMemory(), diskEntries: this.clearDisk() };
    }
    private path(key: string): string {
        const bytes = new Writer().string(key).finish();
        return `cache/${checksum(bytes).toString(16).padStart(8, '0')}${checksum(bytes, 0x12345678).toString(16).padStart(8, '0')}.lod`;
    }
    private trimMemory(): void {
        if (this.memoryLimit < 0) return;
        while (this.memory.size > this.memoryLimit) {
            const first = this.memory.keys().next().value;
            if (first === undefined) break;
            this.memory.delete(first);
        }
    }
    private diskFiles(): { name: string; modified: number; size: number }[] {
        return this.files
            .list('cache')
            .filter((name) => /^[0-9a-f]+\.lod$/.test(name))
            .map((name) => ({ name, info: this.files.stat(`cache/${name}`) }))
            .filter((entry) => entry.info?.kind === 'file')
            .map((entry) => ({
                name: entry.name,
                modified: entry.info?.modified ?? 0,
                size: entry.info?.size ?? 0
            }));
    }
    private pruneDisk(): void {
        if (this.diskLimit < 0) return;
        const entries = this.diskFiles().sort((a, b) => a.modified - b.modified);
        for (const entry of entries.slice(0, Math.max(0, entries.length - this.diskLimit)))
            this.files.remove(`cache/${entry.name}`);
    }
}

function checksum(bytes: Uint8Array, seed = 0x811c9dc5): number {
    let hash = seed;
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    return hash;
}
