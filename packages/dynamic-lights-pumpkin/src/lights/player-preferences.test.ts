import { MemoryFiles } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it, vi } from 'vitest';
import { PlayerLightPreferences } from './player-preferences.ts';

describe(PlayerLightPreferences.name, () => {
    it('keeps the current setting if saving the new one fails', () => {
        const files = new MemoryFiles();
        const preferences = new PlayerLightPreferences(files);
        vi.spyOn(files, 'writeFile').mockImplementation(() => {
            throw new Error('disk full');
        });
        expect(() => preferences.toggle('Alex')).toThrow('disk full');
        expect(preferences.isEnabled('Alex')).toBe(true);
    });

    it('keeps a disabled setting if removing its saved preference fails', () => {
        const files = new MemoryFiles();
        const preferences = new PlayerLightPreferences(files);
        preferences.toggle('Alex');
        vi.spyOn(files, 'remove').mockImplementation(() => {
            throw new Error('permission denied');
        });
        expect(() => preferences.toggle('Alex')).toThrow('permission denied');
        expect(preferences.isEnabled('Alex')).toBe(false);
        expect(new PlayerLightPreferences(files).isEnabled('Alex')).toBe(false);
    });
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
