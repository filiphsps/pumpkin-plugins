import { type BlockPosition, ClientLightTracker, type LightClient } from './client-light.ts';

/** An entity light visible to one player during a refresh. */
export interface VisibleEntityLight {
    /** Stable identifier for the source entity. */
    readonly entityId: number;
    /** Position of the fake client-only light block. */
    readonly position: BlockPosition;
    /** Minecraft light level, from 1 through 15. */
    readonly level: number;
}

/** Maintains client-only lights for configured entities near each player. */
export class EntityLightTracker {
    private readonly lights: ClientLightTracker;
    private readonly visibleIds = new Map<string, Set<number>>();

    constructor(stateForLevel: (level: number) => number) {
        this.lights = new ClientLightTracker(stateForLevel);
    }

    /** Reconciles all entity lights visible to one player. */
    sync(viewerId: string, client: LightClient, visible: readonly VisibleEntityLight[]): void {
        const prefix = `${viewerId}:`;
        const active = new Set<string>();
        for (const light of visible) {
            const key = `${prefix}${light.entityId}`;
            active.add(key);
            this.lights.sync(key, client, light.position, light.level);
        }
        for (const entityId of this.visibleIds.get(viewerId) ?? []) {
            const key = `${prefix}${entityId}`;
            if (!active.has(key)) this.lights.remove(key, client);
        }
        this.visibleIds.set(viewerId, new Set(visible.map((light) => light.entityId)));
    }

    /** Clears all entity lights for a player using the fresh event resource. */
    remove(viewerId: string, client: LightClient): void {
        this.sync(viewerId, client, []);
        this.visibleIds.delete(viewerId);
    }

    /** Forgets client state when the plugin unloads. */
    clear(): void {
        this.lights.clear();
        this.visibleIds.clear();
    }
}
