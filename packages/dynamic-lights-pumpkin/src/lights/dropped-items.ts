/** Tracks the configured luminance of item entities from their spawn events. */
export class DroppedItemLightLevels {
    private readonly levels = new Map<number, number>();

    constructor(private readonly levelForItem: (itemName: string) => number) {}

    /** Records the held-item luminance for a newly spawned item entity. */
    recordSpawn(entityId: number, itemName: string): void {
        this.recordLevel(entityId, this.levelForItem(itemName));
    }

    /** Associates a known item entity with a configured light level. */
    recordLevel(entityId: number, level: number): void {
        if (level > 0) this.levels.set(entityId, level);
        else this.levels.delete(entityId);
    }

    /** Preserves the merged item's luminance on the remaining item entity. */
    merge(entityId: number, targetId: number): void {
        const level = this.levels.get(targetId);
        this.levels.delete(targetId);
        if (level !== undefined) this.levels.set(entityId, Math.max(level, this.levels.get(entityId) ?? 0));
    }

    /** Forgets an item entity that despawned, was picked up or otherwise removed. */
    remove(entityId: number): void {
        this.levels.delete(entityId);
    }

    /** Returns the entity's recorded level, if it was a configured item at spawn time. */
    level(entityId: number): number | undefined {
        return this.levels.get(entityId);
    }
}

/** Identifies a single new item after a drop, excluding existing or ambiguous nearby items. */
export function newDroppedItemId(previous: ReadonlySet<number>, current: readonly number[]): number | undefined {
    const added = [...new Set(current.filter((id) => !previous.has(id)))];
    return added.length === 1 ? added[0] : undefined;
}
