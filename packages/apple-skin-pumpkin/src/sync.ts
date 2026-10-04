/**
 * How far exhaustion has to move before another packet is worth sending. AppleSkin's own server
 * code uses the same threshold: exhaustion creeps up while a player walks or sprints, and the
 * client is fine until the drift is visible.
 */
export const EXHAUSTION_THRESHOLD = 0.01;

/** What the plugin last sent one player. */
interface LastSent {
    saturation: number;
    exhaustion: number;
}

/** What to send one player now. A field is missing when that value has not moved enough to send. */
export interface SyncUpdate {
    /** The player's saturation level, when it moved since the last packet. */
    saturation?: number;
    /** The player's exhaustion level, when it moved by at least `EXHAUSTION_THRESHOLD`. */
    exhaustion?: number;
}

/**
 * Remembers what each player was last sent, so a tick where nothing moved costs no packets. A
 * player is keyed by the id the host adapter derives from their UUID, and forgetting one is what
 * makes their next tick send both values again.
 */
export class SyncTracker {
    private readonly lastSent = new Map<string, LastSent>();

    /**
     * Records a player's values and reports the ones worth sending.
     * @param id - The player's id.
     * @param saturation - The player's saturation level now.
     * @param exhaustion - The player's exhaustion level now.
     * @returns The values to send, which is nothing when neither has moved far enough.
     */
    update(id: string, saturation: number, exhaustion: number): SyncUpdate {
        const last = this.lastSent.get(id);
        if (!last) {
            this.lastSent.set(id, { saturation, exhaustion });
            return { saturation, exhaustion };
        }

        const update: SyncUpdate = {};
        let nextSaturation = last.saturation;
        let nextExhaustion = last.exhaustion;
        if (last.saturation !== saturation) {
            update.saturation = saturation;
            nextSaturation = saturation;
        }
        if (Math.abs(last.exhaustion - exhaustion) >= EXHAUSTION_THRESHOLD) {
            update.exhaustion = exhaustion;
            nextExhaustion = exhaustion;
        }

        // Only what was sent becomes the new baseline. A value that drifted by less than the
        // threshold is still measured against the last packet, so slow drift adds up to one.
        if (update.saturation !== undefined || update.exhaustion !== undefined) {
            this.lastSent.set(id, { saturation: nextSaturation, exhaustion: nextExhaustion });
        }
        return update;
    }

    /**
     * Forgets a player, so their values are sent again the next time they are read.
     * @param id - The player's id.
     */
    forget(id: string): void {
        this.lastSent.delete(id);
    }

    /**
     * Drops the players who are no longer online, for the times no leave event reaches us.
     * @param online - The ids of the players on the server right now.
     */
    retain(online: ReadonlySet<string>): void {
        for (const id of this.lastSent.keys()) if (!online.has(id)) this.lastSent.delete(id);
    }

    /** How many players are being tracked. */
    get size(): number {
        return this.lastSent.size;
    }
}
