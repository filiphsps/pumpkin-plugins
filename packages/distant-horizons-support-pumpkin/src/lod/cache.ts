import type { DataFiles } from '@pumpkin-plugins/plugin-kit/files';
import { Reader, Writer } from '../protocol/bytes.ts';
import { MIN_DTO_BYTES } from './builder.ts';

const MAX_CACHE_FILE_BYTES = 16 * 1024 * 1024;
const CACHE_FILE_READ_CHUNK_BYTES = 1 << 20;
const CACHE_ENTRY_FIXED_BYTES = 20;

/** Last captured terrain data and its server timestamp. */
export interface CachedLod {
    data: Uint8Array;
    updated: number;
}
/** Entry counts and stored bytes for both cache tiers. */
export interface LodCacheStats {
    diskBytes: number;
    diskEntries: number;
    diskLimit: number;
    memoryByteLimit: number;
    memoryBytes: number;
    memoryEntries: number;
    memoryLimit: number;
}
/** Persisted location and key for a selected cache entry exported before repair. */
export interface CacheRecoveryBackup {
    dataPath: string;
    key: string;
    manifestPath: string;
}
/** Persistent bounded cache; corrupt entries are discarded and rebuilt when terrain is available. */
export class LodCache {
    private readonly memory = new Map<string, CachedLod>();
    private readonly diskIndex = new Map<string, { modified: number; size: number }>();
    private readonly diskOrder: string[] = [];
    private diskBytes = 0;
    private memoryBytes = 0;
    /**
     * Opens the cache directory. An entry limit of 0 disables its tier and a negative one means unlimited.
     *
     * @param memoryByteLimit - Payload bytes the memory tier may hold; negative means unlimited.
     */
    constructor(
        private readonly files: DataFiles,
        private readonly memoryLimit: number,
        private readonly diskLimit: number,
        private readonly memoryByteLimit = -1,
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
                if (stat.kind !== 'file' || stat.size > MAX_CACHE_FILE_BYTES) throw new Error('Invalid cached LOD');
                const input = new Reader(this.files.readFile(path));
                if (input.int() !== 0x44485031) throw new Error('Invalid cache format');
                if (input.string() !== key) throw new Error('Cache key mismatch');
                const expected = input.int() >>> 0;
                const updated = input.timestamp();
                const data = input.bytes(input.int());
                input.end();
                if (checksum(data) !== expected || data.length < MIN_DTO_BYTES)
                    throw new Error('Invalid cached payload');
                value = { updated, data };
            } catch {
                this.files.remove(path);
                this.removeDiskIndex(name);
                return undefined;
            }
        }
        this.remember(key, value);
        return value;
    }
    /** Saves a complete capture atomically and evicts entries above their respective limits. */
    put(key: string, value: CachedLod): void {
        const encodedKeyLength = new Writer().string(key).finish().length;
        if (encodedKeyLength + CACHE_ENTRY_FIXED_BYTES + value.data.length > MAX_CACHE_FILE_BYTES) {
            throw new Error('LOD exceeds cache size limit');
        }
        if (this.diskLimit !== 0) {
            const path = this.path(key);
            this.files.writeFile(path, this.encode(key, value));
            const stat = this.files.stat(path);
            if (stat?.kind === 'file') this.indexDiskFile(this.name(key), stat.modified, stat.size);
        }
        this.remember(key, value);
        this.pruneDisk();
    }
    /** Exports one selected entry, records its key, then removes it from the active cache. */
    backupAndRemove(key: string): CacheRecoveryBackup | undefined {
        const name = this.name(key);
        const memoryValue = this.memory.get(key);
        const sourcePath = this.path(key);
        const diskEntry = this.diskIndex.get(name);
        let diskValue: Uint8Array | undefined;
        if (!memoryValue && diskEntry) diskValue = this.readDiskEntry(sourcePath, diskEntry.size);
        if (!memoryValue && !diskValue) return undefined;

        this.files.createDirectory('cache-recovery');
        const files = new Set(this.files.list('cache-recovery'));
        let suffix = 0;
        let stem: string;
        do {
            stem = `${name}-${suffix++}`;
        } while (files.has(`${stem}.dhp`) || files.has(`${stem}.dhm`));

        const dataPath = `cache-recovery/${stem}.dhp`;
        const manifestPath = `cache-recovery/${stem}.dhm`;
        const bytes = memoryValue ? this.encode(key, memoryValue) : diskValue;
        if (!bytes) return undefined;
        this.files.writeFile(dataPath, bytes);
        this.files.writeFile(manifestPath, new Writer().int(0x44485231).string(key).string(dataPath).finish());
        this.remove(key);
        return { key, dataPath, manifestPath };
    }
    /** Invalidates a section affected by a known world change. */
    remove(key: string): void {
        this.forget(key);
        this.removeDiskFile(this.name(key));
    }
    /** Returns cache usage without reading or decoding disk entries. */
    stats(): LodCacheStats {
        return {
            memoryEntries: this.memory.size,
            memoryBytes: this.memoryBytes,
            memoryLimit: this.memoryLimit,
            memoryByteLimit: this.memoryByteLimit,
            diskEntries: this.diskIndex.size,
            diskBytes: this.diskBytes,
            diskLimit: this.diskLimit,
        };
    }
    /** Drops every in-memory entry and returns how many were removed. */
    clearMemory(): number {
        const removed = this.memory.size;
        this.memory.clear();
        this.memoryBytes = 0;
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
    private readDiskEntry(path: string, indexedSize: number): Uint8Array | undefined {
        if (indexedSize > MAX_CACHE_FILE_BYTES) return undefined;
        const file = this.files.open(path);
        try {
            if (file.size > MAX_CACHE_FILE_BYTES) return undefined;
            const bytes = new Uint8Array(file.size);
            let offset = 0;
            while (offset < bytes.length) {
                const chunk = file.read(offset, Math.min(CACHE_FILE_READ_CHUNK_BYTES, bytes.length - offset));
                if (chunk.length === 0) break;
                bytes.set(chunk, offset);
                offset += chunk.length;
            }
            return offset === bytes.length ? bytes : undefined;
        } finally {
            file.close();
        }
    }
    private encode(key: string, value: CachedLod): Uint8Array {
        return new Writer()
            .int(0x44485031)
            .string(key)
            .int(checksum(value.data))
            .timestamp(value.updated)
            .blob(value.data)
            .finish();
    }
    private name(key: string): string {
        const bytes = new Writer().string(key).finish();
        return `${checksum(bytes).toString(16).padStart(8, '0')}${checksum(bytes, 0x12345678).toString(16).padStart(8, '0')}.lod`;
    }
    private remember(key: string, value: CachedLod): void {
        this.forget(key);
        if (this.memoryLimit === 0) return;
        if (this.memoryByteLimit >= 0 && value.data.length > this.memoryByteLimit) return;
        this.memory.set(key, value);
        this.memoryBytes += value.data.length;
        while (
            (this.memoryLimit >= 0 && this.memory.size > this.memoryLimit) ||
            (this.memoryByteLimit >= 0 && this.memoryBytes > this.memoryByteLimit)
        ) {
            const oldest = this.memory.keys().next().value;
            if (oldest === undefined) break;
            this.forget(oldest);
        }
    }
    private forget(key: string): void {
        const value = this.memory.get(key);
        if (!value) return;
        this.memory.delete(key);
        this.memoryBytes -= value.data.length;
    }
    private scanDiskFiles(): { name: string; modified: number; size: number }[] {
        const names = this.files.list('cache');
        // Writes are atomic through a temp sibling; a server killed mid-write leaves one behind.
        for (const name of names) if (/^[0-9a-f]+\.lod\.tmp\.\d+$/.test(name)) this.files.remove(`cache/${name}`);
        return names
            .filter((name) => /^[0-9a-f]+\.lod$/.test(name))
            .map((name) => ({ name, info: this.files.stat(`cache/${name}`) }))
            .filter((entry) => entry.info?.kind === 'file')
            .map((entry) => ({
                name: entry.name,
                modified: entry.info?.modified ?? 0,
                size: entry.info?.size ?? 0,
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
