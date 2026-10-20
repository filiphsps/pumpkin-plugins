import type { DataFiles } from '@pumpkin-plugins/plugin-kit/files';
import { strFromU8, strToU8 } from 'fflate';

const PREFERENCES_FILE = 'disabled-players.json';

/** Stores the UUIDs of players who have chosen to hide dynamic lights, so the choice survives a name change. */
export class PlayerLightPreferences {
    private disabled: Set<string>;

    constructor(private readonly files: DataFiles) {
        this.disabled = readDisabledPlayers(files);
    }

    /** Returns whether a player has dynamic lights enabled. */
    isEnabled(playerId: string): boolean {
        return !this.disabled.has(playerId);
    }

    /** Toggles a player's setting and returns whether dynamic lights are now enabled. */
    toggle(playerId: string): boolean {
        const disabled = new Set(this.disabled);
        const enabled = disabled.delete(playerId);
        if (!enabled) disabled.add(playerId);
        if (disabled.size === 0) this.files.remove(PREFERENCES_FILE);
        else this.files.writeFile(PREFERENCES_FILE, strToU8(JSON.stringify([...disabled].sort())));
        this.disabled = disabled;
        return enabled;
    }
}

function readDisabledPlayers(files: DataFiles): Set<string> {
    if (files.stat(PREFERENCES_FILE) === undefined) return new Set();
    try {
        const value: unknown = JSON.parse(strFromU8(files.readFile(PREFERENCES_FILE)));
        return new Set(
            Array.isArray(value) ? value.filter((player): player is string => typeof player === 'string') : [],
        );
    } catch {
        return new Set();
    }
}
