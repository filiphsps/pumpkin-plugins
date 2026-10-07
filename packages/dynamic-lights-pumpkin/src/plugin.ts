import type { CommandSender, ConsumedArgs } from 'pumpkin:plugin/command@0.1.0';
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
    PlayerTeleportEventData
} from 'pumpkin:plugin/event@0.1.0';
import * as logging from 'pumpkin:plugin/logging@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { ansi } from '@pumpkin-plugins/minecraft-colors';
import { WasiDataDir } from '@pumpkin-plugins/plugin-kit/data-dir';
import { cancelTask, runCommand, scheduleDelayed, scheduleRepeating } from '@pumpkin-plugins/plugin-kit/host';
import { PluginBase, registerPlugin } from '@pumpkin-plugins/plugin-kit/plugin';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import { handleCommand as apiHandleCommand } from '@pumpkinmc/pumpkin-api-ts';
import { registerCommands } from './commands/register.ts';
import { loadPluginConfig } from './config/load.ts';
import { info } from './info.ts';
import { type BlockPosition, ClientLightTracker } from './lights/client-light.ts';
import { DroppedItemLightLevels, newDroppedItemId } from './lights/dropped-items.ts';
import { EntityLightTracker } from './lights/entity-lights.ts';
import { HeldItemLightLevels } from './lights/held-items.ts';
import { LightJournal } from './lights/journal.ts';
import { PlayerLightPreferences } from './lights/player-preferences.ts';
import { resolveClientLightStates } from './platform/client-light-states.ts';
import { nearbyItemIds, playerWorldId, readEntityLights, readHeldLight } from './platform/player-lights.ts';
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
    private readonly playerWorlds = new Map<string, string>();
    private readonly pendingSyncs = new Map<string, number>();
    private readonly delayedTasks = new Set<number>();

    constructor() {
        super(info, __PLUGIN_VERSION__);
    }

    /** Runs when the server loads the plugin. */
    protected onPluginLoad(ctx: Context): void {
        const clientLightStates = resolveClientLightStates();
        if (clientLightStates === undefined) {
            logging.log('error', `${ansi.named.name(info.name)} could not resolve Minecraft light block states`);
            return;
        }
        const files = WasiDataDir.open();
        if (files === undefined) {
            logging.log('error', `${ansi.named.name(info.name)} needs its data-folder permissions to run`);
            return;
        }
        const config = loadPluginConfig(files, (level, message) =>
            logging.log(level, `${ansi.named.name(info.name)}: ${message}`)
        );
        const journal = new LightJournal(files);
        this.preferences = new PlayerLightPreferences(files);
        this.tracker = new ClientLightTracker(clientLightStates);
        this.entityTracker = new EntityLightTracker(this.tracker);
        this.lightLevels = new HeldItemLightLevels(sourceLevels(config.sources));
        this.droppedItemLevels = new DroppedItemLightLevels((itemName) => this.lightLevels?.level(itemName) ?? 0);
        this.entityLevels = new Map(Object.entries(sourceLevels(config.entity_sources)));
        registerCommands(ctx, this);
        if (config.entities.enabled) {
            logging.log(
                'info',
                `${ansi.named.name(info.name)} entity lights enabled for ${ansi.named.number(this.entityLevels.size)} type${this.entityLevels.size === 1 ? '' : 's'} every ${ansi.named.number(config.entities.refresh_interval_ticks)} ticks`
            );
            this.entityTask = scheduleRepeating(config.entities.refresh_interval_ticks, (server) =>
                this.syncEntityLights(server)
            );
        }

        this.registerEvent(ctx, 'player-join-event', (_server, event: PlayerJoinEventData) => {
            this.forgetPlayer(event.player.getName());
            this.deferPlayerSync(event.player.getName(), 2);
        });
        this.registerEvent(ctx, 'player-leave-event', (_server, event: PlayerLeaveEventData) => {
            const playerName = event.player.getName();
            this.forgetPlayer(playerName);
            const pending = this.pendingSyncs.get(playerName);
            if (pending !== undefined) cancelTask(pending);
            if (pending !== undefined) this.delayedTasks.delete(pending);
            this.pendingSyncs.delete(playerName);
        });
        this.registerEvent(ctx, 'player-item-held-event', (_server, event: PlayerItemHeldEventData) => {
            this.deferPlayerSync(event.player.getName());
        });
        this.registerEvent(ctx, 'player-swap-hands-event', (_server, event: PlayerSwapHandsEventData) => {
            this.deferPlayerSync(event.player.getName());
        });
        for (const eventType of [
            'block-place-event',
            'player-item-consume-event',
            'player-bucket-empty-event',
            'player-bucket-fill-event',
            'inventory-click-event',
            'inventory-close-event',
            'inventory-creative-event',
            'inventory-drag-event'
        ] as const) {
            this.registerEvent(ctx, eventType, (_server, event) => this.deferPlayerSync(event.player.getName()));
        }
        this.registerEvent(ctx, 'player-move-event', (_server, event: PlayerMoveEventData) => {
            this.syncMovedPlayer(event.player, event.toPosition);
        });
        this.registerEvent(ctx, 'player-teleport-event', (_server, event: PlayerTeleportEventData) => {
            this.deferPlayerSync(event.player.getName());
        });
        this.registerEvent(ctx, 'player-changed-world-event', (_server, event: PlayerChangedWorldEventData) => {
            this.forgetPlayer(event.player.getName());
            this.deferPlayerSync(event.player.getName());
        });
        this.registerEvent(ctx, 'player-respawn-event', (_server, event: PlayerRespawnEventData) => {
            this.forgetPlayer(event.player.getName());
            this.deferPlayerSync(event.player.getName());
        });
        this.registerEvent(
            ctx,
            'player-drop-item-event',
            (_server, event: PlayerDropItemEventData) => {
                this.deferPlayerSync(event.player.getName());
                const level = this.lightLevels?.level(event.itemName) ?? 0;
                if (event.cancelled || level === 0) return;
                const playerName = event.player.getName();
                const previous = new Set(nearbyItemIds(event.player));
                const worldId = playerWorldId(event.player);
                this.defer((server) => this.recordPlayerDrop(server, playerName, level, worldId, previous));
            },
            'lowest'
        );
        this.registerEvent(
            ctx,
            'item-spawn-event',
            (_server, event: ItemSpawnEventData) => {
                if (!event.cancelled) this.droppedItemLevels?.recordSpawn(event.entityId, event.itemName);
            },
            'lowest'
        );
        this.registerEvent(
            ctx,
            'item-merge-event',
            (_server, event: ItemMergeEventData) => {
                if (!event.cancelled) this.droppedItemLevels?.merge(event.entityId, event.targetId);
            },
            'lowest'
        );
        this.registerEvent(
            ctx,
            'item-despawn-event',
            (_server, event: ItemDespawnEventData) => {
                if (!event.cancelled) this.droppedItemLevels?.remove(event.entityId);
            },
            'lowest'
        );
        this.registerEvent(ctx, 'entity-remove-event', (_server, event: EntityRemoveEventData) => {
            this.droppedItemLevels?.remove(event.entityId);
        });
        this.registerEvent(ctx, 'server-load-event', (server: Server) => {
            const worlds = server.getAllWorlds();
            let recovered: number;
            try {
                recovered = journal.recover(worlds.map((world) => new PumpkinLightWorld(world)));
            } finally {
                for (const world of worlds) disposeWasiResource(world);
            }
            if (recovered > 0)
                logging.log(
                    'warn',
                    `${ansi.named.name(info.name)} restored ${ansi.named.number(recovered)} stale temporary light level${recovered === 1 ? '' : 's'}`
                );
            const players = server.getAllPlayers();
            try {
                for (const player of players) this.syncPlayer(player);
            } finally {
                for (const player of players) disposeWasiResource(player);
            }
        });
    }

    /** Drops tracked client overrides before Pumpkin unloads the plugin. */
    protected override onPluginUnload(ctx: Context): void {
        for (const task of this.delayedTasks) cancelTask(task);
        this.delayedTasks.clear();
        this.pendingSyncs.clear();
        if (this.entityTask !== undefined) cancelTask(this.entityTask);
        this.entityTask = undefined;
        const server = ctx.getServer();
        try {
            const players = server.getAllPlayers();
            try {
                for (const player of players) this.tracker?.reset(player.getName(), player);
            } finally {
                for (const player of players) disposeWasiResource(player);
            }
        } finally {
            disposeWasiResource(server);
        }
        this.tracker?.clear();
        this.playerBlockPositions.clear();
        this.playerWorlds.clear();
    }

    private syncPlayer(player: PlayerJoinEventData['player']): void {
        const playerName = player.getName();
        if (!this.preferences?.isEnabled(playerName)) {
            this.tracker?.reset(playerName, player);
            return;
        }
        const light = readHeldLight(player, this.lightLevels);
        this.observeWorld(playerName, light.worldId);
        this.playerBlockPositions.set(playerName, light.position);
        this.tracker?.sync(playerName, player, light.lightPosition, light.level);
    }

    private syncMovedPlayer(player: PlayerJoinEventData['player'], precisePosition: [number, number, number]): void {
        const playerName = player.getName();
        const [x, y, z] = precisePosition;
        const previous = this.playerBlockPositions.get(playerName);
        if (previous?.x === Math.floor(x) && previous.y === Math.floor(y) && previous.z === Math.floor(z)) return;
        this.deferPlayerSync(playerName);
    }

    private deferPlayerSync(playerName: string, delay = 1): void {
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

    private defer(run: (server: Server) => void, delay = 1): number {
        const task = scheduleDelayed(delay, (server) => {
            this.delayedTasks.delete(task);
            run(server);
        });
        this.delayedTasks.add(task);
        return task;
    }

    private forgetPlayer(playerName: string): void {
        this.tracker?.forget(playerName);
        this.playerBlockPositions.delete(playerName);
        this.playerWorlds.delete(playerName);
    }

    private observeWorld(playerName: string, worldId: string): void {
        if (this.playerWorlds.get(playerName) !== worldId) this.forgetPlayer(playerName);
        this.playerWorlds.set(playerName, worldId);
    }

    private syncEntityLights(server: Server): void {
        const players = server.getAllPlayers();
        try {
            for (const player of players) this.syncPlayerEntities(player);
        } finally {
            for (const player of players) disposeWasiResource(player);
        }
    }

    private syncPlayerEntities(player: PlayerJoinEventData['player']): void {
        const playerName = player.getName();
        if (!this.preferences?.isEnabled(playerName)) {
            this.entityTracker?.remove(playerName, player);
            return;
        }
        const lights = readEntityLights(
            player,
            (entity) => this.droppedItemLevels?.level(entity.getId()) ?? this.entityLevels.get(entity.getType()) ?? 0
        );
        this.observeWorld(playerName, lights.worldId);
        this.entityTracker?.sync(playerName, player, lights.visible);
    }

    private recordPlayerDrop(
        server: Server,
        playerName: string,
        level: number,
        worldId: string,
        previous: ReadonlySet<number>
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

    /** Toggles one player's dynamic lights and immediately clears them when disabling. */
    togglePlayerLights(player: PlayerJoinEventData['player']): boolean {
        const enabled = this.preferences?.toggle(player.getName()) ?? true;
        if (enabled) this.syncPlayer(player);
        else {
            this.tracker?.reset(player.getName(), player);
        }
        return enabled;
    }
}

function sourceLevels(sources: Record<string, { light_level?: number }>): Record<string, number> {
    const levels: Record<string, number> = Object.create(null);
    for (const [item, source] of Object.entries(sources)) {
        if (source.light_level !== undefined) levels[item] = source.light_level;
    }
    return levels;
}

registerPlugin(new DynamicLightsPumpkin());

export { handleTask } from '@pumpkin-plugins/plugin-kit/plugin';

/** Dispatches plugin command handlers before delegating to Pumpkin's API package. */
export function handleCommand(id: number, sender: CommandSender, server: Server, args: ConsumedArgs): number {
    return runCommand(id, sender, args) ?? apiHandleCommand(id, sender, server, args);
}

export * from '@pumpkinmc/pumpkin-api-ts';
