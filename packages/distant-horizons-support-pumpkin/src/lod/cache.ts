import type { DataFiles } from '@pumpkin-plugins/plugin-kit/files';
import { Reader, Writer } from '../protocol/bytes.ts';

/** Last captured terrain data and its server timestamp. */
export interface CachedLod {
    data: Uint8Array;
    updated: number;
}
/** Persistent bounded cache; corrupt entries are discarded and rebuilt when terrain is available. */
export class LodCache {
    private readonly memory = new Map<string, CachedLod>();
    constructor(
        private readonly files: DataFiles,
        private readonly limit: number
    ) {
        files.createDirectory('cache');
        this.prune();
    }
    /** Looks up a captured section, without allocating for oversized or corrupt files. */
    get(key: string): CachedLod | undefined {
        let value = this.memory.get(key);
        if (!value) {
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
        this.memory.delete(key);
        this.memory.set(key, value);
        this.trimMemory();
        return value;
    }
    /** Saves a complete capture atomically and evicts the oldest files above the limit. */
    put(key: string, value: CachedLod): void {
        if (value.data.length > 16 * 1024 * 1024) throw new Error('LOD exceeds cache size limit');
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
        this.memory.delete(key);
        this.memory.set(key, value);
        this.trimMemory();
        this.prune();
    }
    /** Invalidates a section affected by a known world change. */
    remove(key: string): void {
        this.memory.delete(key);
        const path = this.path(key);
        if (this.files.stat(path)) this.files.remove(path);
    }
    private path(key: string): string {
        const bytes = new Writer().string(key).finish();
        return `cache/${checksum(bytes).toString(16).padStart(8, '0')}${checksum(bytes, 0x12345678).toString(16).padStart(8, '0')}.lod`;
    }
    private trimMemory(): void {
        while (this.memory.size > this.limit) {
            const first = this.memory.keys().next().value;
            if (first === undefined) break;
            this.memory.delete(first);
        }
    }
    private prune(): void {
        const entries = this.files
            .list('cache')
            .filter((name) => /^[0-9a-f]+\.lod$/.test(name))
            .map((name) => ({ name, modified: this.files.stat(`cache/${name}`)?.modified ?? 0 }))
            .sort((a, b) => a.modified - b.modified);
        for (const entry of entries.slice(0, Math.max(0, entries.length - this.limit)))
            this.files.remove(`cache/${entry.name}`);
    }
}

function checksum(bytes: Uint8Array, seed = 0x811c9dc5): number {
    let hash = seed;
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    return hash;
}
