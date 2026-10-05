import { describe, expect, it } from 'vitest';
import { HeldItemLightLevels } from './held-items.ts';

describe(HeldItemLightLevels.name, () => {
    it('uses the configured level for a supported source', () => {
        const levels = new HeldItemLightLevels({ 'minecraft:lava_bucket': 15 });

        expect(levels.level('minecraft:lava_bucket')).toBe(15);
        expect(levels.level('lava_bucket')).toBe(15);
    });

    it('returns zero for an unsupported or empty hand', () => {
        const levels = new HeldItemLightLevels({});

        expect(levels.level('minecraft:dirt')).toBe(0);
        expect(levels.level(undefined)).toBe(0);
    });

    it('uses the brighter configured source from either hand', () => {
        const levels = new HeldItemLightLevels({
            'minecraft:lantern': 15,
            'minecraft:torch': 14
        });

        expect(levels.levelForHands('torch', 'lantern')).toBe(15);
        expect(levels.levelForHands(undefined, 'torch')).toBe(14);
    });
});
