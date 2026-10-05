import type { CommandSender, ConsumedArgs } from 'pumpkin:plugin/command@0.1.0';
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type {
    EntityRemoveEventData,
    ItemDespawnEventData,
    ItemMergeEventData,
    ItemSpawnEventData,
    PlayerChangeWorldEventData,
    PlayerDropItemEventData,
    PlayerItemHeldEventData,
    PlayerJoinEventData,
    PlayerLeaveEventData,
    PlayerMoveEventData,
    PlayerRespawnEventData,
    PlayerSwapHandsEventData,
    PlayerTeleportEventData
} from 'pumpkin:plugin/event@0.1.0';
import * as logging from 'pumpkin:plugin/logging@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { WasiDataDir } from '@pumpkin-plugins/plugin-kit/data-dir';
import { cancelTask, runCommand, scheduleDelayed, scheduleRepeating } from '@pumpkin-plugins/plugin-kit/host';
import { colorLogValue } from '@pumpkin-plugins/plugin-kit/logger';
import { PluginBase, registerPlugin } from '@pumpkin-plugins/plugin-kit/plugin';
import { handleCommand as apiHandleCommand } from '@pumpkinmc/pumpkin-api-ts';
import { registerCommands } from './commands/register.ts';
import { loadPluginConfig } from './config/load.ts';
import { info } from './info.ts';
import { type BlockPosition, ClientLightTracker } from './lights/client-light.ts';
import { DroppedItemLightLevels } from './lights/dropped-items.ts';
import { EntityLightTracker, type VisibleEntityLight } from './lights/entity-lights.ts';
import { HeldItemLightLevels } from './lights/held-items.ts';
import { LightJournal } from './lights/journal.ts';
import { PlayerLightPreferences } from './lights/player-preferences.ts';
import { findClientLightPosition } from './platform/client-light-position.ts';
import { resolveClientLightStates } from './platform/client-light-states.ts';
import { PumpkinLightWorld } from './platform/pumpkin-light-world.ts';

/** The plugin. Pumpkin creates it once and calls `onLoad` when the server starts. */
class DynamicLightsPumpkin extends PluginBase {
    private tracker: ClientLightTracker | undefined;
    private entityTracker: EntityLightTracker | undefined;
    private lightLevels: HeldItemLightLevels | undefined;
    private entityLevels = new Map<string, number>();
    private droppedItemLevels: DroppedItemLightLevels | undefined;
    private preferences: PlayerLightPreferences | undefined;
    private entityTask: number | undefined;
    private readonly playerBlockPositions = new Map<string, BlockPosition>();

    constructor() {
        super(info, __PLUGIN_VERSION__);
    }

    /** Runs when the server loads the plugin. */
    protected onPluginLoad(ctx: Context): void {
        const clientLightStates = resolveClientLightStates();
        if (clientLightStates === undefined) {
            logging.log('error', `${colorLogValue(info.name, 'cyan')} could not resolve Minecraft light block states`);
            return;
        }
        const files = WasiDataDir.open();
        if (files === undefined) {
            logging.log('error', `${colorLogValue(info.name, 'cyan')} needs its data-folder permissions to run`);
            return;
        }
        const config = loadPluginConfig(files, (level, message) =>
            logging.log(level, `${colorLogValue(info.name, 'cyan')}: ${message}`)
        );
        const journal = new LightJournal(files);
        this.preferences = new PlayerLightPreferences(files);
        this.tracker = new ClientLightTracker(clientLightStates);
        this.entityTracker = new EntityLightTracker(clientLightStates);
        this.lightLevels = new HeldItemLightLevels(sourceLevels(config.sources));
        this.droppedItemLevels = new DroppedItemLightLevels((itemName) => this.lightLevels?.level(itemName) ?? 0);
        this.entityLevels = new Map(Object.entries(sourceLevels(config.entity_sources)));
        registerCommands(ctx, this);
        if (config.entities.enabled) {
            logging.log(
                'info',
                `${colorLogValue(info.name, 'cyan')} entity lights enabled for ${colorLogValue(String(this.entityLevels.size), 'yellow')} type${this.entityLevels.size === 1 ? '' : 's'} every ${colorLogValue(String(config.entities.refresh_interval_ticks), 'yellow')} ticks`
            );
            this.entityTask = scheduleRepeating(config.entities.refresh_interval_ticks, (server) =>
                this.syncEntityLights(server)
            );
        }

        this.registerEvent(ctx, 'player-join-event', (_server, event: PlayerJoinEventData) => {
            this.syncPlayer(event.player);
            const playerName = event.player.getName();
            scheduleDelayed(2, (server) => {
                const player = server.getPlayerByName(playerName);
                if (player !== undefined) this.syncPlayer(player);
            });
        });
        this.registerEvent(ctx, 'player-leave-event', (_server, event: PlayerLeaveEventData) => {
            const playerName = event.player.getName();
            this.playerBlockPositions.delete(playerName);
            this.tracker?.remove(playerName, event.player);
            this.entityTracker?.remove(playerName, event.player);
        });
        this.registerEvent(ctx, 'player-item-held-event', (_server, event: PlayerItemHeldEventData) => {
            this.syncPlayer(event.player);
        });
        this.registerEvent(ctx, 'player-swap-hands-event', (_server, event: PlayerSwapHandsEventData) => {
            this.syncPlayer(event.player);
        });
        this.registerEvent(ctx, 'player-move-event', (_server, event: PlayerMoveEventData) => {
            this.syncMovedPlayer(event.player, event.toPosition);
        });
        this.registerEvent(ctx, 'player-teleport-event', (_server, event: PlayerTeleportEventData) => {
            this.syncPlayer(event.player, event.toPosition);
        });
        this.registerEvent(ctx, 'player-change-world-event', (_server, event: PlayerChangeWorldEventData) => {
            this.syncPlayer(event.player, event.position);
        });
        this.registerEvent(ctx, 'player-respawn-event', (_server, event: PlayerRespawnEventData) => {
            this.syncPlayer(event.player, event.position);
        });
        this.registerEvent(ctx, 'player-drop-item-event', (_server, event: PlayerDropItemEventData) => {
            const level = this.lightLevels?.level(event.itemName) ?? 0;
            if (level === 0) return;
            const playerName = event.player.getName();
            scheduleDelayed(1, (server) => this.recordPlayerDrop(server, playerName, level));
        });
        this.registerEvent(ctx, 'item-spawn-event', (_server, event: ItemSpawnEventData) => {
            this.droppedItemLevels?.recordSpawn(event.entityId, event.itemName);
        });
        this.registerEvent(ctx, 'item-merge-event', (_server, event: ItemMergeEventData) => {
            this.droppedItemLevels?.merge(event.entityId, event.targetId);
        });
        this.registerEvent(ctx, 'item-despawn-event', (_server, event: ItemDespawnEventData) => {
            this.droppedItemLevels?.remove(event.entityId);
        });
        this.registerEvent(ctx, 'entity-remove-event', (_server, event: EntityRemoveEventData) => {
            this.droppedItemLevels?.remove(event.entityId);
        });
        this.registerEvent(ctx, 'server-load-event', (server: Server) => {
            const recovered = journal.recover(server.getAllWorlds().map((world) => new PumpkinLightWorld(world)));
            if (recovered > 0)
                logging.log(
                    'warn',
                    `${colorLogValue(info.name, 'cyan')} restored ${colorLogValue(String(recovered), 'yellow')} stale temporary light level${recovered === 1 ? '' : 's'}`
                );
            for (const player of server.getAllPlayers()) this.syncPlayer(player);
        });
    }

    /** Drops tracked client overrides before Pumpkin unloads the plugin. */
    protected override onPluginUnload(_ctx: Context): void {
        this.tracker?.clear();
        this.entityTracker?.clear();
        if (this.entityTask !== undefined) cancelTask(this.entityTask);
    }

    private syncPlayer(player: PlayerJoinEventData['player'], precisePosition = player.getPosition()): void {
        const playerName = player.getName();
        const position = toBlockPosition(precisePosition);
        this.playerBlockPositions.set(playerName, position);
        if (!this.preferences?.isEnabled(playerName)) {
            this.tracker?.remove(playerName, player);
            return;
        }
        const rightItem = player.getItemInHand('right');
        const leftItem = player.getItemInHand('left');
        const level = this.lightLevels?.levelForHands(rightItem?.getRegistryKey(), leftItem?.getRegistryKey()) ?? 0;
        const lightPosition = level === 0 ? position : findClientLightPosition(player.getWorld(), position);
        this.tracker?.sync(playerName, player, lightPosition ?? position, lightPosition === undefined ? 0 : level);
    }

    private syncMovedPlayer(player: PlayerJoinEventData['player'], precisePosition: [number, number, number]): void {
        const playerName = player.getName();
        const [x, y, z] = precisePosition;
        const previous = this.playerBlockPositions.get(playerName);
        if (previous?.x === Math.floor(x) && previous.y === Math.floor(y) && previous.z === Math.floor(z)) return;
        this.syncPlayer(player, precisePosition);
    }

    private syncEntityLights(server: Server): void {
        if (this.entityLevels.size === 0) return;
        const players = server.getAllPlayers();
        if (players.length === 0) return;
        for (const player of players) {
            const playerName = player.getName();
            if (!this.preferences?.isEnabled(playerName)) {
                this.entityTracker?.remove(playerName, player);
                continue;
            }
            const visible: VisibleEntityLight[] = [];
            const world = player.getWorld();
            for (const entity of player.asEntity().getNearbyEntities(15, 15, 15)) {
                const entityId = entity.getId();
                const level = this.droppedItemLevels?.level(entityId) ?? this.entityLevels.get(entity.getType()) ?? 0;
                if (level === 0) continue;
                const position = findClientLightPosition(world, toBlockPosition(entity.getPosition()));
                if (position !== undefined) visible.push({ entityId, position, level });
            }
            this.entityTracker?.sync(playerName, player, visible);
        }
    }

    private recordPlayerDrop(server: Server, playerName: string, level: number): void {
        const player = server.getPlayerByName(playerName);
        if (player === undefined) return;
        const [playerX, playerY, playerZ] = player.getPosition();
        const candidates = player
            .asEntity()
            .getNearbyEntities(2, 2, 2)
            .filter(
                (entity) => entity.getType() === 'item' && this.droppedItemLevels?.level(entity.getId()) === undefined
            )
            .sort(
                (left, right) =>
                    distanceSquared(left.getPosition(), playerX, playerY, playerZ) -
                    distanceSquared(right.getPosition(), playerX, playerY, playerZ)
            );
        const dropped = candidates[0];
        if (dropped !== undefined) this.droppedItemLevels?.recordLevel(dropped.getId(), level);
    }

    /** Toggles one player's dynamic lights and immediately clears them when disabling. */
    togglePlayerLights(player: PlayerJoinEventData['player']): boolean {
        const enabled = this.preferences?.toggle(player.getName()) ?? true;
        if (enabled) this.syncPlayer(player);
        else {
            this.tracker?.remove(player.getName(), player);
            this.entityTracker?.remove(player.getName(), player);
        }
        return enabled;
    }
}

function toBlockPosition([x, y, z]: [number, number, number]): BlockPosition {
    return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
}

function sourceLevels(sources: Record<string, { light_level?: number }>): Record<string, number> {
    const levels: Record<string, number> = {};
    for (const [item, source] of Object.entries(sources)) {
        if (source.light_level !== undefined) levels[item] = source.light_level;
    }
    return levels;
}

function distanceSquared(
    [x, y, z]: [number, number, number],
    originX: number,
    originY: number,
    originZ: number
): number {
    return (x - originX) ** 2 + (y - originY) ** 2 + (z - originZ) ** 2;
}

registerPlugin(new DynamicLightsPumpkin());

export { handleTask } from '@pumpkin-plugins/plugin-kit/plugin';

/** Dispatches plugin command handlers before delegating to Pumpkin's API package. */
export function handleCommand(id: number, sender: CommandSender, server: Server, args: ConsumedArgs): number {
    return runCommand(id, sender, args) ?? apiHandleCommand(id, sender, server, args);
}

export * from '@pumpkinmc/pumpkin-api-ts';
