import type { DataFiles } from '@pumpkin-plugins/plugin-kit/files';
import { strFromU8, strToU8 } from 'fflate';
import type { BlockPosition } from './client-light.ts';

const JOURNAL_FILE = 'active-lights.json';

/** A temporary light override recorded before it is applied to the world. */
interface JournalEntry {
    /** The key that identifies this cell in the tracker. */
    readonly key: string;
    /** The world containing the block. */
    readonly worldId: string;
    /** The block position whose light level was temporarily changed. */
    readonly position: BlockPosition;
    /** The block-light level to restore after recovery. */
    readonly originalLevel: number;
    /** Every temporary level this cell may still contain. */
    readonly appliedLevels: readonly number[];
}

/** The world operations needed to recover lights written by older plugin versions. */
export interface LightRecoveryWorld {
    /** Identifies this world for recovery bookkeeping. */
    readonly id: string;
    /** Returns the current server block-light level at a position. */
    getBlockLight(position: BlockPosition): number;
    /** Restores a server block-light level at a position. */
    setBlockLight(position: BlockPosition, level: number): void;
}

/** Persists temporary-light ownership so an interrupted server can clean up on its next start. */
export class LightJournal {
    private readonly entries = new Map<string, JournalEntry>();

    constructor(private readonly files: DataFiles) {
        for (const entry of readEntries(files)) this.entries.set(entry.key, entry);
    }

    /** Restores light levels changed by an interrupted server in worlds loaded at startup. */
    recover(worlds: readonly LightRecoveryWorld[]): number {
        const byId = new Map(worlds.map((world) => [world.id, world]));
        let removed = 0;
        let changed = false;
        for (const [key, entry] of this.entries) {
            const world = byId.get(entry.worldId);
            if (world === undefined) continue;
            if (entry.appliedLevels.includes(world.getBlockLight(entry.position))) {
                world.setBlockLight(entry.position, entry.originalLevel);
                removed += 1;
            }
            this.entries.delete(key);
            changed = true;
        }
        if (changed) this.write();
        return removed;
    }

    private write(): void {
        if (this.entries.size === 0) {
            this.files.remove(JOURNAL_FILE);
            return;
        }
        this.files.writeFile(JOURNAL_FILE, strToU8(JSON.stringify([...this.entries.values()])));
    }
}

function readEntries(files: DataFiles): JournalEntry[] {
    if (files.stat(JOURNAL_FILE) === undefined) return [];
    try {
        const value: unknown = JSON.parse(strFromU8(files.readFile(JOURNAL_FILE)));
        if (!Array.isArray(value)) return [];
        return value.filter(isJournalEntry);
    } catch {
        return [];
    }
}

function isJournalEntry(value: unknown): value is JournalEntry {
    if (typeof value !== 'object' || value === null) return false;
    const entry = value as Partial<JournalEntry>;
    return (
        typeof entry.key === 'string' &&
        typeof entry.worldId === 'string' &&
        isPosition(entry.position) &&
        isLightLevel(entry.originalLevel) &&
        Array.isArray(entry.appliedLevels) &&
        entry.appliedLevels.every(isLightLevel)
    );
}

function isPosition(value: unknown): value is BlockPosition {
    if (typeof value !== 'object' || value === null) return false;
    const position = value as Partial<BlockPosition>;
    return [position.x, position.y, position.z].every(
        (coordinate) =>
            typeof coordinate === 'number' &&
            Number.isInteger(coordinate) &&
            coordinate >= -2147483648 &&
            coordinate <= 2147483647
    );
}

function isLightLevel(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 15;
}
