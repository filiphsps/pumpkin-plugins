import type { PlayerDropItemEventData, PlayerJoinEventData } from 'pumpkin:plugin/event@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import * as uuid from 'pumpkin:plugin/uuid@0.1.0';
import { cancelTask, scheduleDelayed } from '@pumpkin-plugins/plugin-kit/host';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import type { BlockPosition, ClientLightTracker } from './lights/client-light.ts';
import { type DroppedItemLightLevels, newDroppedItemId } from './lights/dropped-items.ts';
import type { EntityLightTracker } from './lights/entity-lights.ts';
import type { HeldItemLightLevels } from './lights/held-items.ts';
import type { PlayerLightPreferences } from './lights/player-preferences.ts';
import { nearbyItemIds, playerWorldId, readEntityLights, readHeldLight } from './platform/player-lights.ts';

/** Keeps each player's client-side lights in step with what they hold and the light sources around them. */
export class LightSync {
    private readonly playerBlockPositions = new Map<string, BlockPosition>();
    private readonly playerWorlds = new Map<string, string>();
    private readonly pendingSyncs = new Map<string, number>();
    private readonly delayedTasks = new Set<number>();

    constructor(
        private readonly preferences: PlayerLightPreferences,
        private readonly tracker: ClientLightTracker,
        private readonly entityTracker: EntityLightTracker,
        private readonly lightLevels: HeldItemLightLevels,
        private readonly entityLevels: ReadonlyMap<string, number>,
        private readonly droppedItemLevels: DroppedItemLightLevels | undefined,
    ) {}

    /** Sends the player's held light now, or clears it when they turned dynamic lights off. */
    syncPlayer(player: PlayerJoinEventData['player']): void {
        const playerName = player.getName();
        if (!this.preferences.isEnabled(uuid.toString(player.getId()))) {
            this.tracker.reset(playerName, player);
            return;
        }
        const light = readHeldLight(player, this.lightLevels);
        this.observeWorld(playerName, light.worldId);
        this.playerBlockPositions.set(playerName, light.position);
        this.tracker.sync(playerName, player, light.lightPosition, light.level);
    }

    /** Schedules a refresh only when a move takes the player into another block. */
    syncMovedPlayer(player: PlayerJoinEventData['player'], precisePosition: [number, number, number]): void {
        const playerName = player.getName();
        const [x, y, z] = precisePosition;
        const previous = this.playerBlockPositions.get(playerName);
        if (previous?.x === Math.floor(x) && previous.y === Math.floor(y) && previous.z === Math.floor(z)) return;
        this.deferPlayerSync(playerName);
    }

    /**
     * Refreshes the player's held light after the current event has finished, at most once per player at a time.
     *
     * @param delay - Ticks to wait; defaults to one.
     */
    deferPlayerSync(playerName: string, delay = 1): void {
        if (this.pendingSyncs.has(playerName)) return;
        const task = this.defer((server) => {
            this.pendingSyncs.delete(playerName);
            const player = server.getPlayerByName(playerName);
            if (player == null) return;
            try {
                this.syncPlayer(player);
            } finally {
                disposeWasiResource(player);
            }
        }, delay);
        this.pendingSyncs.set(playerName, task);
    }

    /** Cancels the player's pending refresh, if one is scheduled. */
    cancelPlayerSync(playerName: string): void {
        const pending = this.pendingSyncs.get(playerName);
        if (pending !== undefined) cancelTask(pending);
        if (pending !== undefined) this.delayedTasks.delete(pending);
        this.pendingSyncs.delete(playerName);
    }

    /** Forgets the lights and position tracked for the player, without changing their client. */
    forgetPlayer(playerName: string): void {
        this.tracker.forget(playerName);
        this.playerBlockPositions.delete(playerName);
        this.playerWorlds.delete(playerName);
    }

    /** Refreshes the entity and dropped-item lights each online player can see. */
    syncEntityLights(server: Server): void {
        const players = server.getAllPlayers();
        try {
            for (const player of players) this.syncPlayerEntities(player);
        } finally {
            for (const player of players) disposeWasiResource(player);
        }
    }

    /** Gives the item a player dropped its light level once the drop has spawned as an entity. */
    trackPlayerDrop(event: PlayerDropItemEventData): void {
        const level = this.lightLevels.level(event.itemName);
        if (event.cancelled || level === 0 || this.droppedItemLevels === undefined) return;
        const playerName = event.player.getName();
        const previous = new Set(nearbyItemIds(event.player));
        const worldId = playerWorldId(event.player);
        this.defer((server) => this.recordPlayerDrop(server, playerName, level, worldId, previous));
    }

    /** Toggles one player's dynamic lights and immediately clears them when disabling. */
    togglePlayerLights(player: PlayerJoinEventData['player']): boolean {
        const enabled = this.preferences.toggle(uuid.toString(player.getId()));
        if (enabled) this.syncPlayer(player);
        else {
            this.tracker.reset(player.getName(), player);
        }
        return enabled;
    }

    /** Cancels every scheduled refresh. */
    cancelPendingSyncs(): void {
        for (const task of this.delayedTasks) cancelTask(task);
        this.delayedTasks.clear();
        this.pendingSyncs.clear();
    }

    /** Restores the client blocks this plugin changed for the player. */
    resetPlayer(player: PlayerJoinEventData['player']): void {
        this.tracker.reset(player.getName(), player);
    }

    /** Forgets every tracked light and position, without changing any client. */
    clear(): void {
        this.tracker.clear();
        this.playerBlockPositions.clear();
        this.playerWorlds.clear();
    }

    private defer(run: (server: Server) => void, delay = 1): number {
        const task = scheduleDelayed(delay, (server) => {
            this.delayedTasks.delete(task);
            run(server);
        });
        this.delayedTasks.add(task);
        return task;
    }

    private observeWorld(playerName: string, worldId: string): void {
        if (this.playerWorlds.get(playerName) !== worldId) this.forgetPlayer(playerName);
        this.playerWorlds.set(playerName, worldId);
    }

    private syncPlayerEntities(player: PlayerJoinEventData['player']): void {
        const playerName = player.getName();
        if (!this.preferences.isEnabled(uuid.toString(player.getId()))) {
            this.entityTracker.remove(playerName, player);
            return;
        }
        const lights = readEntityLights(
            player,
            (entity) => this.droppedItemLevels?.level(entity.getId()) ?? this.entityLevels.get(entity.getType()) ?? 0,
        );
        this.observeWorld(playerName, lights.worldId);
        this.entityTracker.sync(playerName, player, lights.visible);
    }

    private recordPlayerDrop(
        server: Server,
        playerName: string,
        level: number,
        worldId: string,
        previous: ReadonlySet<number>,
    ): void {
        const player = server.getPlayerByName(playerName);
        if (player == null) return;
        try {
            if (playerWorldId(player) !== worldId) return;
            const dropped = newDroppedItemId(previous, nearbyItemIds(player));
            if (dropped !== undefined) this.droppedItemLevels?.recordLevel(dropped, level);
        } finally {
            disposeWasiResource(player);
        }
    }
}
