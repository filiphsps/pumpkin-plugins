import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type {
    BlockBreakEventData,
    BlockGrowEventData,
    BlockPlaceEventData,
    BlockSpreadEventData,
    PlayerCustomPayloadEventData,
    PlayerLeaveEventData,
} from 'pumpkin:plugin/event@0.1.0';
import type { IpcMessage, PluginId } from 'pumpkin:plugin/ipc@0.1.0';
import { ansi } from '@pumpkin-plugins/minecraft-colors';
import { WasiDataDir } from '@pumpkin-plugins/plugin-kit/data-dir';
import { hostLogger } from '@pumpkin-plugins/plugin-kit/host';
import { ipcSend } from '@pumpkin-plugins/plugin-kit/ipc';
import { taggedLogger } from '@pumpkin-plugins/plugin-kit/logger';
import { PluginBase, registerPlugin } from '@pumpkin-plugins/plugin-kit/plugin';
import { registerCommands } from '@pumpkin-plugins/plugin-kit/register-commands';
import { monotonicMs } from '@pumpkin-plugins/plugin-kit/wasi-clock';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import { PumpkinPlusPlusSession, WarningScope } from '@pumpkin-plugins/pumpkin-plus-plus-api';
import { commandHandlers } from './commands/handlers.ts';
import { commands } from './commands/spec.ts';
import { readSettings } from './config/load.ts';
import { info } from './info.ts';
import { LodCache } from './lod/cache.ts';
import { PLUGIN_NAME } from './name.ts';
import { DistantHorizonsPlaceholderService } from './placeholders/service.ts';
import { serverPeers, withPlayer } from './platform/peers.ts';
import { invalidateBlockGrow, invalidateBlockSpread } from './platform/world-mutations.ts';
import { CHANNEL, PROTOCOL } from './protocol/messages.ts';
import { Sessions } from './session.ts';

const log = taggedLogger(ansi.named.name(PLUGIN_NAME), hostLogger);

/** Serves Distant Horizons requests from loaded chunks and previously captured terrain. */
class DistantHorizonsSupportPumpkin extends PluginBase {
    private dataDir: WasiDataDir | undefined;
    private placeholders: DistantHorizonsPlaceholderService | undefined;
    private sessions: Sessions | undefined;

    constructor() {
        super(info, __PLUGIN_VERSION__);
    }
    /** Loads bounded settings and installs request, tick and world-change handlers. */
    protected onPluginLoad(ctx: Context): void {
        const files = WasiDataDir.open();
        if (!files) throw new Error(`${PLUGIN_NAME} requires access to its data folder`);
        this.dataDir = files;
        try {
            this.initializePlugin(ctx, files);
        } catch (error) {
            this.stopPlaceholders();
            this.stopSessions();
            this.disposeDataDir();
            throw error;
        }
    }

    private initializePlugin(ctx: Context, files: WasiDataDir): void {
        const settings = readSettings(files, log);
        const cache = new LodCache(
            files,
            settings.memory_cache_entries,
            settings.disk_cache_entries,
            settings.memory_cache_mb * 1024 * 1024,
        );
        const provider = new PumpkinPlusPlusSession({
            send: ipcSend,
            now: monotonicMs,
            warn: hostLogger.warn,
            warnings: new WarningScope(),
        });
        const sessions = new Sessions(settings, cache, log, Date.now, monotonicMs, provider, monotonicMs);
        this.sessions = sessions;
        this.placeholders = new DistantHorizonsPlaceholderService({
            sessions,
            cache,
            now: monotonicMs,
            onTransition: (state) => log.info(`PumpkinPIE provider is ${ansi.named.value(state.kind)}`),
        });
        registerCommands(ctx, commands, commandHandlers(sessions, cache, settings));
        this.registerEvent(ctx, 'player-custom-payload-event', (_server, event: PlayerCustomPayloadEventData) => {
            if (event.channel !== CHANNEL) return;
            try {
                withPlayer(event.player, settings, (peer) => sessions.receive(peer, event.data));
            } catch (err) {
                const name = event.player.getName();
                sessions.endSession(name);
                log.warn(`DH message from ${ansi.named.name(name)} failed: ${String(err)}`);
            }
        });
        this.registerEvent(ctx, 'player-leave-event', (_server, event: PlayerLeaveEventData) => {
            sessions.playerLeft(event.player.getName());
        });
        this.registerEvent(ctx, 'server-tick-end-event', (server) => {
            const peers = serverPeers(server, settings);
            try {
                sessions.tick(peers, server.getMspt());
            } finally {
                peers[Symbol.dispose]();
            }
            try {
                this.placeholders?.tick();
            } catch (err) {
                log.warn(`PumpkinPIE session tick failed: ${String(err)}`);
            }
        });
        this.registerEvent(ctx, 'block-place-event', (_server, event: BlockPlaceEventData) => {
            if (event.cancelled) return;
            const world = event.player.getWorld();
            try {
                sessions.changed(world.getName(), event.blockPos.x, event.blockPos.z);
            } finally {
                disposeWasiResource(world);
            }
        });
        this.registerEvent(ctx, 'block-break-event', (_server, event: BlockBreakEventData) => {
            if (event.cancelled || !event.player) return;
            const world = event.player.getWorld();
            try {
                sessions.changed(world.getName(), event.blockPos.x, event.blockPos.z);
            } finally {
                disposeWasiResource(world);
            }
        });
        this.registerEvent(ctx, 'block-grow-event', (_server, event: BlockGrowEventData) => {
            invalidateBlockGrow(sessions, event);
        });
        this.registerEvent(ctx, 'block-spread-event', (_server, event: BlockSpreadEventData) => {
            invalidateBlockSpread(sessions, event);
        });
        log.info(
            `serving DH protocol ${ansi.named.number(PROTOCOL)} through Pumpkin's terrain adapter and cached terrain. Optional Pumpkin++ preparation can make chunks available, but the plugin still samples through that adapter; see the README's Terrain access section.`,
        );
    }

    protected override onPluginUnload(_ctx: Context): void {
        this.stopPlaceholders();
        this.stopSessions();
        this.disposeDataDir();
    }

    /** Releases the local PumpkinPIE session before the plugin's data directory. */
    private stopPlaceholders(): void {
        const placeholders = this.placeholders;
        this.placeholders = undefined;
        try {
            placeholders?.stop();
        } catch (err) {
            log.warn(`failed to stop PumpkinPIE session: ${String(err)}`);
        }
    }

    /** Drops pending provider state before the plugin's data directory closes. */
    private stopSessions(): void {
        const sessions = this.sessions;
        this.sessions = undefined;
        try {
            sessions?.dispose();
        } catch {
            log.warn(`${PLUGIN_NAME}: failed to stop Distant Horizons sessions`);
        }
    }

    /** Routes authenticated provider callbacks to the active expansion router. */
    override handleIpcMessage(sender: PluginId, message: IpcMessage): IpcMessage {
        const placeholders = this.placeholders;
        return placeholders === undefined
            ? super.handleIpcMessage(sender, message)
            : placeholders.handleIpcMessage(sender, message);
    }

    private disposeDataDir(): void {
        const files = this.dataDir;
        this.dataDir = undefined;
        files?.[Symbol.dispose]();
    }
}

registerPlugin(new DistantHorizonsSupportPumpkin());

export { handleCommand, handleTask } from '@pumpkin-plugins/plugin-kit/plugin';
export * from '@pumpkin-plugins/pumpkin-api';
