import { canonicalRegistryId } from '@pumpkin-plugins/plugin-kit/registry-id';

/** Resolves the configured light level of held items. */
export class HeldItemLightLevels {
    constructor(private readonly sources: Readonly<Record<string, number>>) {}

    /** Returns an item's configured luminance, or zero when it is not a light source. */
    level(itemName: string | undefined): number {
        if (itemName === undefined) return 0;
        return this.sources[canonicalRegistryId(itemName)] ?? 0;
    }

    /** Returns the brighter configured level from a player's main hand and offhand. */
    levelForHands(rightItemName: string | undefined, leftItemName: string | undefined): number {
        return Math.max(this.level(rightItemName), this.level(leftItemName));
    }
}
