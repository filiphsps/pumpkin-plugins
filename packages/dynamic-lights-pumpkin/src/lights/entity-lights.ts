import type { BlockPosition, ClientLightTracker, LightClient } from './client-light.ts';

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
    constructor(private readonly lights: ClientLightTracker) {}

    /** Reconciles all entity lights visible to one player. */
    sync(viewerId: string, client: LightClient, visible: readonly VisibleEntityLight[]): void {
        this.lights.replaceSources(viewerId, client, 'entities', visible);
    }

    /** Clears all entity lights for a player using the fresh event resource. */
    remove(viewerId: string, client: LightClient): void {
        this.sync(viewerId, client, []);
    }
}
