import type { DataFiles } from '@pumpkin-plugins/plugin-kit/files';
import { strFromU8, strToU8 } from 'fflate';

const PREFERENCES_FILE = 'disabled-players.json';

/** Stores the players who have chosen to hide dynamic lights. */
export class PlayerLightPreferences {
    private readonly disabled: Set<string>;

    constructor(private readonly files: DataFiles) {
        this.disabled = readDisabledPlayers(files);
    }

    /** Returns whether a player has dynamic lights enabled. */
    isEnabled(playerName: string): boolean {
        return !this.disabled.has(playerName);
    }

    /** Toggles a player's setting and returns whether dynamic lights are now enabled. */
    toggle(playerName: string): boolean {
        const enabled = this.disabled.delete(playerName);
        if (!enabled) this.disabled.add(playerName);
        this.write();
        return enabled;
    }

    private write(): void {
        if (this.disabled.size === 0) {
            this.files.remove(PREFERENCES_FILE);
            return;
        }
        this.files.writeFile(PREFERENCES_FILE, strToU8(JSON.stringify([...this.disabled].sort())));
    }
}

function readDisabledPlayers(files: DataFiles): Set<string> {
    if (files.stat(PREFERENCES_FILE) === undefined) return new Set();
    try {
        const value: unknown = JSON.parse(strFromU8(files.readFile(PREFERENCES_FILE)));
        return new Set(
            Array.isArray(value) ? value.filter((player): player is string => typeof player === 'string') : []
        );
    } catch {
        return new Set();
    }
}
