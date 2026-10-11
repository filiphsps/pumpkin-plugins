import type { DataFiles } from '../platform/files.ts';
import { readAddon } from './addon.ts';
import type { ScannedPack } from './entries.ts';
import { ManifestError, readManifest } from './manifest.ts';

/** Folder inside the packs folder that holds `.mcpack` files made from `.mcaddon` bundles. */
export const EXTRACTED_FOLDER = '.extracted';

/** What one scan of the packs folder found. */
export interface ScanResult {
    /** Packs whose manifest could be read. */
    packs: ScannedPack[];
    /** One message per file, or pack inside a bundle, that had to be left out, starting with its name. */
    problems: string[];
}

interface CacheEntry {
    size: number;
    modified: number;
    outcome: ScanResult;
    reservations: string;
}

const isMcpack = (name: string) => /\.mcpack$/i.test(name);
const isMcaddon = (name: string) => /\.mcaddon$/i.test(name);
const stem = (name: string) => name.replace(/\.(mcpack|mcaddon)$/i, '');
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Finds `.mcpack` and `.mcaddon` files and reads the resource packs in them. A file is only read
 * again when its size or modification time changes, so scanning stays cheap with large packs.
 * The resource packs in a `.mcaddon` are written out as `.mcpack` files in a hidden folder next
 * to it, so they can be served like any other pack.
 */
export class PackScanner {
    private readonly cache = new Map<string, CacheEntry>();

    /** Creates a scanner over the plugin's data folder. */
    constructor(private readonly files: DataFiles) {}

    /**
     * Scans a folder.
     * @param directory - The packs folder, relative to the data folder. It must exist.
     * @returns The packs found, in file name order, and what was left out.
     */
    scan(directory: string): ScanResult {
        const packs: ScannedPack[] = [];
        const problems: string[] = [];
        const present = new Set<string>();
        const taken = new Map<string, string>();

        // Packs people placed themselves come first, so they keep their name if a bundle's pack would clash.
        const sources = this.files.list(directory).filter((n) => isMcpack(n) || isMcaddon(n));
        sources.sort((a, b) => Number(isMcaddon(a)) - Number(isMcaddon(b)) || (a < b ? -1 : a > b ? 1 : 0));
        for (const source of sources) {
            if (isMcpack(source) && this.files.stat(`${directory}/${source}`)?.kind === 'file') {
                taken.set(source, source);
            }
        }
        for (const source of sources) {
            const info = this.files.stat(`${directory}/${source}`);
            if (info?.kind !== 'file') continue;
            present.add(source);

            const reservations = isMcaddon(source) ? JSON.stringify([...taken]) : '';
            let entry = this.cache.get(source);
            if (entry?.size !== info.size || entry.modified !== info.modified || entry.reservations !== reservations) {
                entry = {
                    size: info.size,
                    modified: info.modified,
                    reservations,
                    outcome: this.read(directory, source, info, taken)
                };
                this.cache.set(source, entry);
            }

            problems.push(...entry.outcome.problems);
            for (const pack of entry.outcome.packs) {
                const first = taken.get(pack.fileName);
                if (first && first !== source)
                    problems.push(`${source}: ${pack.fileName} is already taken by ${first}; skipping it`);
                else {
                    taken.set(pack.fileName, source);
                    packs.push(pack);
                }
            }
        }

        for (const source of this.cache.keys()) if (!present.has(source)) this.cache.delete(source);
        this.removeStaleExtractions(directory, present);
        return { packs, problems };
    }

    private read(
        directory: string,
        source: string,
        info: { size: number; modified: number },
        taken: ReadonlyMap<string, string>
    ): ScanResult {
        const path = `${directory}/${source}`;
        try {
            const bytes = this.files.readFile(path);
            if (!isMcaddon(source)) {
                const manifest = readManifest(bytes);
                return {
                    packs: [{ fileName: source, path, size: info.size, modified: info.modified, manifest }],
                    problems: []
                };
            }
            return this.extract(directory, source, info.modified, bytes, taken);
        } catch (err) {
            const reason = err instanceof ManifestError ? err.message : `could not be read (${errorText(err)})`;
            return { packs: [], problems: [`${source}: ${reason}`] };
        }
    }

    private extract(
        directory: string,
        source: string,
        modified: number,
        bytes: Uint8Array,
        taken: ReadonlyMap<string, string>
    ): ScanResult {
        const { packs: found, skipped } = readAddon(bytes);
        const problems = skipped.map((s) => `${source}: left out ${s}`);
        if (found.length === 0) problems.push(`${source}: has no resource pack`);

        const folder = `${directory}/${EXTRACTED_FOLDER}/${source}`;
        this.clearFolder(folder);
        const packs: ScannedPack[] = [];
        if (found.length > 0) this.files.createDirectory(folder);
        const reserved = new Map(taken);
        for (const pack of found) {
            const fileName = found.length === 1 ? `${stem(source)}.mcpack` : `${stem(source)} - ${pack.name}.mcpack`;
            const first = reserved.get(fileName);
            if (first) {
                problems.push(`${source}: ${fileName} is already taken by ${first}; skipping it`);
                continue;
            }
            reserved.set(fileName, source);
            const path = `${folder}/${fileName}`;
            this.files.writeFile(path, pack.bytes);
            packs.push({ fileName, path, size: pack.bytes.length, modified, manifest: pack.manifest });
        }
        return { packs, problems };
    }

    private removeStaleExtractions(directory: string, present: Set<string>): void {
        const root = `${directory}/${EXTRACTED_FOLDER}`;
        if (!this.files.stat(root)) return;
        for (const name of this.files.list(root)) {
            if (present.has(name)) continue;
            this.clearFolder(`${root}/${name}`);
        }
    }

    private clearFolder(folder: string): void {
        if (this.files.stat(folder)?.kind !== 'directory') return;
        for (const name of this.files.list(folder)) this.files.remove(`${folder}/${name}`);
        this.files.remove(folder);
    }
}
