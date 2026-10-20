import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type { PlayerJoinEventData } from 'pumpkin:plugin/event@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { ansi } from '@pumpkin-plugins/minecraft-colors';
import { WasiDataDir } from '@pumpkin-plugins/plugin-kit/data-dir';
import { cancelTask, hostLogger, scheduleRepeating } from '@pumpkin-plugins/plugin-kit/host';
import { taggedLogger } from '@pumpkin-plugins/plugin-kit/logger';
import { PluginBase, registerPlugin } from '@pumpkin-plugins/plugin-kit/plugin';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import { registerCommands } from './commands/register.ts';
import { loadPluginConfig } from './config/load.ts';
import { registerDroppedItemEvents, registerPlayerEvents } from './events.ts';
import { info } from './info.ts';
import { LightSync } from './light-sync.ts';
import { ClientLightTracker } from './lights/client-light.ts';
import { DroppedItemLightLevels } from './lights/dropped-items.ts';
import { EntityLightTracker } from './lights/entity-lights.ts';
import { HeldItemLightLevels } from './lights/held-items.ts';
import { LightJournal } from './lights/journal.ts';
import { PlayerLightPreferences } from './lights/player-preferences.ts';
import { resolveClientLightStates } from './platform/client-light-states.ts';
import { PumpkinLightWorld } from './platform/pumpkin-light-world.ts';

const log = taggedLogger(ansi.named.name(info.name), hostLogger);

/** The plugin. Pumpkin creates it once and calls `onLoad` when the server starts. */
class DynamicLightsPumpkin extends PluginBase {
    private dataDir: WasiDataDir | undefined;
    private sync: LightSync | undefined;
    private entityTask: number | undefined;
    private started = false;

    constructor() {
        super(info, __PLUGIN_VERSION__);
    }

    /** Runs when the server loads the plugin. */
    protected onPluginLoad(ctx: Context): void {
        const clientLightStates = resolveClientLightStates();
        if (clientLightStates === undefined) {
            log.error('could not resolve Minecraft light block states');
            return;
        }
        const files = WasiDataDir.open();
        if (files === undefined) {
            log.error('needs its data-folder permissions to run');
            return;
        }
        this.dataDir = files;
        try {
            this.initializePlugin(ctx, files, clientLightStates);
        } catch (error) {
            try {
                if (this.entityTask !== undefined) cancelTask(this.entityTask);
                this.entityTask = undefined;
            } finally {
                this.disposeDataDir();
            }
            throw error;
        }
    }

    private initializePlugin(ctx: Context, files: WasiDataDir, clientLightStates: (level: number) => number): void {
        const config = loadPluginConfig(files, (level, message) => log[level](message));
        const journal = new LightJournal(files);
        const preferences = new PlayerLightPreferences(files);
        const tracker = new ClientLightTracker(clientLightStates);
        const entityTracker = new EntityLightTracker(tracker);
        const lightLevels = new HeldItemLightLevels(sourceLevels(config.sources));
        const entityLevels = new Map(Object.entries(sourceLevels(config.entity_sources)));
        // Dropped items are lit by the entity refresh, so they share its setting.
        const droppedItemLevels = config.entities.enabled
            ? new DroppedItemLightLevels((itemName) => lightLevels.level(itemName))
            : undefined;
        const sync = new LightSync(preferences, tracker, entityTracker, lightLevels, entityLevels, droppedItemLevels);
        this.sync = sync;
        registerCommands(ctx, this);
        if (droppedItemLevels !== undefined) {
            registerDroppedItemEvents(this, ctx, droppedItemLevels);
            log.info(
                `entity lights enabled for ${ansi.named.number(entityLevels.size)} type${entityLevels.size === 1 ? '' : 's'} every ${ansi.named.number(config.entities.refresh_interval_ticks)} ticks`,
            );
            this.entityTask = scheduleRepeating(config.entities.refresh_interval_ticks, (server) =>
                sync.syncEntityLights(server),
            );
        }

        registerPlayerEvents(this, ctx, sync);
        this.registerEvent(ctx, 'server-load-event', (server: Server) => {
            this.start(server, journal, sync);
        });
        // `/plugin load` and hot reload don't fire server-load-event, so start now if players are online.
        const server = ctx.getServer();
        try {
            const players = server.getAllPlayers();
            for (const player of players) disposeWasiResource(player);
            if (players.length > 0) this.start(server, journal, sync);
        } finally {
            disposeWasiResource(server);
        }
    }

    /** Repairs lights left by earlier versions and lights the players already online, once per load. */
    private start(server: Server, journal: LightJournal, sync: LightSync): void {
        if (this.started) return;
        this.started = true;
        const worlds = server.getAllWorlds();
        let recovered: number;
        try {
            recovered = journal.recover(worlds.map((world) => new PumpkinLightWorld(world)));
        } finally {
            for (const world of worlds) disposeWasiResource(world);
        }
        if (recovered > 0)
            log.warn(
                `restored ${ansi.named.number(recovered)} stale temporary light level${recovered === 1 ? '' : 's'}`,
            );
        const players = server.getAllPlayers();
        try {
            for (const player of players) sync.syncPlayer(player);
        } finally {
            for (const player of players) disposeWasiResource(player);
        }
    }

    /** Drops tracked client overrides before Pumpkin unloads the plugin. */
    protected override onPluginUnload(ctx: Context): void {
        try {
            this.sync?.cancelPendingSyncs();
            if (this.entityTask !== undefined) cancelTask(this.entityTask);
            this.entityTask = undefined;
            const server = ctx.getServer();
            try {
                const players = server.getAllPlayers();
                try {
                    for (const player of players) this.sync?.resetPlayer(player);
                } finally {
                    for (const player of players) disposeWasiResource(player);
                }
            } finally {
                disposeWasiResource(server);
            }
        } finally {
            this.sync?.clear();
            this.disposeDataDir();
        }
    }

    private disposeDataDir(): void {
        const files = this.dataDir;
        this.dataDir = undefined;
        disposeWasiResource(files);
    }

    /** Toggles one player's dynamic lights and immediately clears them when disabling. */
    togglePlayerLights(player: PlayerJoinEventData['player']): boolean {
        return this.sync?.togglePlayerLights(player) ?? true;
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

export { handleCommand, handleTask } from '@pumpkin-plugins/plugin-kit/plugin';

export * from '@pumpkin-plugins/pumpkin-api';
