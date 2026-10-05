import { MemoryFiles } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it } from 'vitest';
import { PlayerLightPreferences } from './player-preferences.ts';

describe(PlayerLightPreferences.name, () => {
    it("persists a player's disabled setting and removes it when re-enabled", () => {
        const files = new MemoryFiles();
        const preferences = new PlayerLightPreferences(files);

        expect(preferences.toggle('Alex')).toBe(false);
        expect(preferences.isEnabled('Alex')).toBe(false);
        expect(files.text('disabled-players.json')).toBe('["Alex"]');
        expect(new PlayerLightPreferences(files).isEnabled('Alex')).toBe(false);

        expect(preferences.toggle('Alex')).toBe(true);
        expect(files.stat('disabled-players.json')).toBeUndefined();
    });
});
