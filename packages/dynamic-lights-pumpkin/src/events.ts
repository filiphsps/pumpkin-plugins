import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type {
    EntityRemoveEventData,
    ItemDespawnEventData,
    ItemMergeEventData,
    ItemSpawnEventData,
    PlayerChangedWorldEventData,
    PlayerDropItemEventData,
    PlayerItemHeldEventData,
    PlayerJoinEventData,
    PlayerLeaveEventData,
    PlayerMoveEventData,
    PlayerRespawnEventData,
    PlayerSwapHandsEventData,
    PlayerTeleportEventData,
} from 'pumpkin:plugin/event@0.1.0';
import type { PluginBase } from '@pumpkin-plugins/plugin-kit/plugin';
import type { LightSync } from './light-sync.ts';
import type { DroppedItemLightLevels } from './lights/dropped-items.ts';

/** Refreshes a player's lights after the events that can change what they hold, where they are or their world. */
export function registerPlayerEvents(plugin: PluginBase, ctx: Context, sync: LightSync): void {
    plugin.registerEvent(ctx, 'player-join-event', (_server, event: PlayerJoinEventData) => {
        sync.forgetPlayer(event.player.getName());
        sync.deferPlayerSync(event.player.getName(), 2);
    });
    plugin.registerEvent(ctx, 'player-leave-event', (_server, event: PlayerLeaveEventData) => {
        const playerName = event.player.getName();
        sync.forgetPlayer(playerName);
        sync.cancelPlayerSync(playerName);
    });
    plugin.registerEvent(ctx, 'player-item-held-event', (_server, event: PlayerItemHeldEventData) => {
        sync.deferPlayerSync(event.player.getName());
    });
    plugin.registerEvent(ctx, 'player-swap-hands-event', (_server, event: PlayerSwapHandsEventData) => {
        sync.deferPlayerSync(event.player.getName());
    });
    for (const eventType of [
        'block-place-event',
        'player-item-consume-event',
        'player-bucket-empty-event',
        'player-bucket-fill-event',
        'inventory-click-event',
        'inventory-close-event',
        'inventory-creative-event',
        'inventory-drag-event',
    ] as const) {
        plugin.registerEvent(ctx, eventType, (_server, event) => {
            sync.deferPlayerSync(event.player.getName());
        });
    }
    plugin.registerEvent(ctx, 'player-move-event', (_server, event: PlayerMoveEventData) => {
        sync.syncMovedPlayer(event.player, event.toPosition);
    });
    plugin.registerEvent(ctx, 'player-teleport-event', (_server, event: PlayerTeleportEventData) => {
        sync.deferPlayerSync(event.player.getName());
    });
    plugin.registerEvent(ctx, 'player-changed-world-event', (_server, event: PlayerChangedWorldEventData) => {
        sync.forgetPlayer(event.player.getName());
        sync.deferPlayerSync(event.player.getName());
    });
    plugin.registerEvent(ctx, 'player-respawn-event', (_server, event: PlayerRespawnEventData) => {
        sync.forgetPlayer(event.player.getName());
        sync.deferPlayerSync(event.player.getName());
    });
    // `lowest` asks to run after other plugins so `cancelled` is final. Pumpkin 0.2.0+26.3-26.51
    // ignores priority and runs handlers in registration order, so a later plugin can still cancel.
    plugin.registerEvent(
        ctx,
        'player-drop-item-event',
        (_server, event: PlayerDropItemEventData) => {
            sync.deferPlayerSync(event.player.getName());
            sync.trackPlayerDrop(event);
        },
        'lowest',
    );
}

/** Tracks dropped items for the entity refresh, with `lowest` priority as for the drop event. */
export function registerDroppedItemEvents(
    plugin: PluginBase,
    ctx: Context,
    droppedItemLevels: DroppedItemLightLevels,
): void {
    plugin.registerEvent(
        ctx,
        'item-spawn-event',
        (_server, event: ItemSpawnEventData) => {
            if (!event.cancelled) droppedItemLevels.recordSpawn(event.entityId, event.itemName);
        },
        'lowest',
    );
    plugin.registerEvent(
        ctx,
        'item-merge-event',
        (_server, event: ItemMergeEventData) => {
            if (!event.cancelled) droppedItemLevels.merge(event.entityId, event.targetId);
        },
        'lowest',
    );
    plugin.registerEvent(
        ctx,
        'item-despawn-event',
        (_server, event: ItemDespawnEventData) => {
            if (!event.cancelled) droppedItemLevels.remove(event.entityId);
        },
        'lowest',
    );
    plugin.registerEvent(ctx, 'entity-remove-event', (_server, event: EntityRemoveEventData) => {
        droppedItemLevels.remove(event.entityId);
    });
}
