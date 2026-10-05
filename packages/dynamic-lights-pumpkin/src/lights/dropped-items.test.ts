import { describe, expect, it } from 'vitest';
import { DroppedItemLightLevels, newDroppedItemId } from './dropped-items.ts';

describe(DroppedItemLightLevels.name, () => {
    it('uses the same level for spawned drops as for held items', () => {
        const levels = new DroppedItemLightLevels((item) => (item === 'torch' ? 14 : 0));

        levels.recordSpawn(4, 'torch');
        levels.recordSpawn(5, 'dirt');

        expect(levels.level(4)).toBe(14);
        expect(levels.level(5)).toBeUndefined();
    });

    it('keeps a light when its item entity merges or is removed', () => {
        const levels = new DroppedItemLightLevels(() => 14);
        levels.recordSpawn(4, 'torch');

        levels.merge(8, 4);
        expect(levels.level(4)).toBeUndefined();
        expect(levels.level(8)).toBe(14);

        levels.remove(8);
        expect(levels.level(8)).toBeUndefined();
    });

    it('can associate a dropped entity identified after a player drop', () => {
        const levels = new DroppedItemLightLevels(() => 0);

        levels.recordLevel(4, 14);

        expect(levels.level(4)).toBe(14);
    });
});

describe('newDroppedItemId', () => {
    it('identifies only a newly observed item entity', () => {
        expect(newDroppedItemId(new Set([4]), [4, 5])).toBe(5);
        expect(newDroppedItemId(new Set([4]), [4])).toBeUndefined();
    });

    it('does not guess when multiple new drops are nearby', () => {
        expect(newDroppedItemId(new Set([4]), [4, 5, 6])).toBeUndefined();
    });
});
