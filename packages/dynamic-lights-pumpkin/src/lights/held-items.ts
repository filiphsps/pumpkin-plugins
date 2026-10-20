import { canonicalRegistryId } from '@pumpkin-plugins/plugin-kit/registry-id';

/** Resolves the configured light level of held items. */
export class HeldItemLightLevels {
    private readonly sources = new Map<string, number>();

    /** Accepts item IDs with or without the `minecraft:` namespace. */
    constructor(sources: Readonly<Record<string, number>>) {
        for (const [item, level] of Object.entries(sources)) this.sources.set(canonicalRegistryId(item), level);
    }

    /** Returns an item's configured luminance, or zero when it is not a light source. */
    level(itemName: string | undefined): number {
        if (itemName === undefined) return 0;
        return this.sources.get(canonicalRegistryId(itemName)) ?? 0;
    }

    /** Returns the brighter configured level from a player's main hand and offhand. */
    levelForHands(rightItemName: string | undefined, leftItemName: string | undefined): number {
        return Math.max(this.level(rightItemName), this.level(leftItemName));
    }
}
