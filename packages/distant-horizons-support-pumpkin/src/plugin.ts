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
import { now as monotonicNow } from 'wasi:clocks/monotonic-clock@0.2.3';
import { WasiDataDir } from '@pumpkin-plugins/plugin-kit/data-dir';
import { hostLogger } from '@pumpkin-plugins/plugin-kit/host';
import { ipcSend } from '@pumpkin-plugins/plugin-kit/ipc';
import { PluginBase, registerPlugin } from '@pumpkin-plugins/plugin-kit/plugin';
import { registerCommands } from '@pumpkin-plugins/plugin-kit/register-commands';
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
        const settings = readSettings(files, hostLogger);
        const cache = new LodCache(files, settings.memory_cache_entries, settings.disk_cache_entries);
        const provider = new PumpkinPlusPlusSession({
            send: ipcSend,
            now: monotonicMilliseconds,
            warn: hostLogger.warn,
            warnings: new WarningScope(),
        });
        const sessions = new Sessions(settings, cache, hostLogger, Date.now, Date.now, provider, monotonicMilliseconds);
        this.sessions = sessions;
        this.placeholders = new DistantHorizonsPlaceholderService({
            sessions,
            cache,
            now: monotonicMilliseconds,
            onTransition: (state) => hostLogger.info(`${PLUGIN_NAME}: PumpkinPIE provider is ${state.kind}`),
        });
        registerCommands(ctx, commands, commandHandlers(sessions, cache, settings));
        this.registerEvent(ctx, 'player-custom-payload-event', (_server, event: PlayerCustomPayloadEventData) => {
            if (event.channel !== CHANNEL) return;
            try {
                withPlayer(event.player, settings, (peer) => sessions.receive(peer, event.data));
            } catch (err) {
                sessions.left(event.player.getName());
                hostLogger.warn(`${PLUGIN_NAME}: cannot open DH session: ${String(err)}`);
            }
        });
        this.registerEvent(ctx, 'player-leave-event', (_server, event: PlayerLeaveEventData) => {
            sessions.playerLeft(event.player.getName());
        });
        this.registerEvent(ctx, 'server-tick-end-event', (server) => {
            sessions.tick(serverPeers(server, settings, hostLogger), server.getMspt());
            try {
                this.placeholders?.tick();
            } catch {
                hostLogger.warn(`${PLUGIN_NAME}: PumpkinPIE session tick failed`);
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
        hostLogger.info(
            `${PLUGIN_NAME}: serving DH protocol ${PROTOCOL} through Pumpkin's terrain adapter and cached terrain. Optional Pumpkin++ preparation can make chunks available, but the plugin still samples through that adapter. See the README's Terrain access section.`,
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
        } catch {
            hostLogger.warn(`${PLUGIN_NAME}: failed to stop PumpkinPIE session`);
        }
    }

    /** Cancels pending Pumpkin++ jobs and releases prepared leases before plugin resources close. */
    private stopSessions(): void {
        const sessions = this.sessions;
        this.sessions = undefined;
        try {
            sessions?.dispose();
        } catch {
            hostLogger.warn(`${PLUGIN_NAME}: failed to stop Distant Horizons sessions`);
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

function monotonicMilliseconds(): number {
    return Number(monotonicNow() / 1_000_000n);
}

registerPlugin(new DistantHorizonsSupportPumpkin());

export { handleCommand, handleTask } from '@pumpkin-plugins/plugin-kit/plugin';
export * from '@pumpkin-plugins/pumpkin-api';
