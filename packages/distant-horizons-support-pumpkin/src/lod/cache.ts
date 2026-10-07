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
    private readonly diskIndex = new Map<string, { modified: number; size: number }>();
    private readonly diskOrder: string[] = [];
    private diskBytes = 0;
    constructor(
        private readonly files: DataFiles,
        private readonly memoryLimit: number,
        private readonly diskLimit: number
    ) {
        files.createDirectory('cache');
        for (const entry of this.scanDiskFiles()) this.indexDiskFile(entry.name, entry.modified, entry.size);
        this.pruneDisk();
    }
    /** Checks for a stored capture without reading it into memory or changing its cache order. */
    has(key: string): boolean {
        if (this.memory.has(key)) return true;
        if (this.diskLimit === 0) return false;
        return this.diskIndex.has(this.name(key));
    }
    /** Looks up a captured section, without allocating for oversized or corrupt files. */
    get(key: string): CachedLod | undefined {
        let value = this.memory.get(key);
        if (!value) {
            if (this.diskLimit === 0) return undefined;
            const name = this.name(key);
            if (!this.diskIndex.has(name)) return undefined;
            const path = `cache/${name}`;
            const stat = this.files.stat(path);
            if (!stat) {
                this.removeDiskIndex(name);
                return undefined;
            }
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
                this.removeDiskIndex(name);
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
        if (this.diskLimit !== 0) {
            const path = this.path(key);
            this.files.writeFile(
                path,
                new Writer()
                    .int(0x44485031)
                    .string(key)
                    .int(checksum(value.data))
                    .timestamp(value.updated)
                    .blob(value.data)
                    .finish()
            );
            const stat = this.files.stat(path);
            if (stat?.kind === 'file') this.indexDiskFile(this.name(key), stat.modified, stat.size);
        }
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
        this.removeDiskFile(this.name(key));
    }
    /** Returns cache usage without reading or decoding disk entries. */
    stats(): LodCacheStats {
        let memoryBytes = 0;
        for (const value of this.memory.values()) memoryBytes += value.data.length;
        return {
            memoryEntries: this.memory.size,
            memoryBytes,
            memoryLimit: this.memoryLimit,
            diskEntries: this.diskIndex.size,
            diskBytes: this.diskBytes,
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
        const names = [...this.diskIndex.keys()];
        for (const name of names) this.removeDiskFile(name);
        return names.length;
    }
    /** Drops both cache tiers and reports how many entries were removed from each. */
    clear(): { memoryEntries: number; diskEntries: number } {
        return { memoryEntries: this.clearMemory(), diskEntries: this.clearDisk() };
    }
    private path(key: string): string {
        return `cache/${this.name(key)}`;
    }
    private name(key: string): string {
        const bytes = new Writer().string(key).finish();
        return `${checksum(bytes).toString(16).padStart(8, '0')}${checksum(bytes, 0x12345678).toString(16).padStart(8, '0')}.lod`;
    }
    private trimMemory(): void {
        if (this.memoryLimit < 0) return;
        while (this.memory.size > this.memoryLimit) {
            const first = this.memory.keys().next().value;
            if (first === undefined) break;
            this.memory.delete(first);
        }
    }
    private scanDiskFiles(): { name: string; modified: number; size: number }[] {
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
        while (this.diskOrder.length > this.diskLimit) {
            const oldest = this.diskOrder[0];
            if (oldest === undefined) return;
            this.removeDiskFile(oldest);
        }
    }
    private indexDiskFile(name: string, modified: number, size: number): void {
        this.removeDiskIndex(name);
        this.diskIndex.set(name, { modified, size });
        this.diskBytes += size;
        let low = 0;
        let high = this.diskOrder.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            const candidateName = this.diskOrder[middle];
            const candidate = candidateName ? this.diskIndex.get(candidateName) : undefined;
            if (
                candidateName !== undefined &&
                candidate &&
                (candidate.modified < modified || (candidate.modified === modified && candidateName < name))
            )
                low = middle + 1;
            else high = middle;
        }
        this.diskOrder.splice(low, 0, name);
    }
    private removeDiskIndex(name: string): void {
        const entry = this.diskIndex.get(name);
        if (!entry) return;
        this.diskIndex.delete(name);
        this.diskBytes -= entry.size;
        const index = this.diskOrder.indexOf(name);
        if (index >= 0) this.diskOrder.splice(index, 1);
    }
    private removeDiskFile(name: string): void {
        if (!this.diskIndex.has(name)) return;
        this.files.remove(`cache/${name}`);
        this.removeDiskIndex(name);
    }
}

function checksum(bytes: Uint8Array, seed = 0x811c9dc5): number {
    let hash = seed;
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    return hash;
}
