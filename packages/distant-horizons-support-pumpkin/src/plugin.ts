import type { CommandSender, ConsumedArgs } from 'pumpkin:plugin/command@0.1.0';
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type {
    BlockBreakEventData,
    BlockPlaceEventData,
    PlayerCustomPayloadEventData,
    PlayerLeaveEventData
} from 'pumpkin:plugin/event@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { WasiDataDir } from '@pumpkin-plugins/plugin-kit/data-dir';
import { hostLogger, runCommand } from '@pumpkin-plugins/plugin-kit/host';
import { PluginBase, registerPlugin } from '@pumpkin-plugins/plugin-kit/plugin';
import { registerCommands } from '@pumpkin-plugins/plugin-kit/register-commands';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import { handleCommand as apiHandleCommand } from '@pumpkinmc/pumpkin-api-ts';
import { commands } from './commands/spec.ts';
import { readSettings } from './config/load.ts';
import { info } from './info.ts';
import { LodCache } from './lod/cache.ts';
import { serverPeers, withPlayer } from './platform/peers.ts';
import { CHANNEL } from './protocol/messages.ts';
import { Sessions } from './session.ts';

/** Serves DH protocol 16 requests from loaded chunks and previously captured terrain. */
class DistantHorizonsSupportPumpkin extends PluginBase {
    constructor() {
        super(info, __PLUGIN_VERSION__);
    }
    /** Loads bounded settings and installs request, tick and world-change handlers. */
    protected onPluginLoad(ctx: Context): void {
        const files = WasiDataDir.open();
        if (!files) throw new Error('DistantHorizonsSupportPumpkin requires access to its data folder');
        const settings = readSettings(files, hostLogger);
        const sessions = new Sessions(settings, new LodCache(files, settings.cache_entries), hostLogger);
        registerCommands(ctx, commands, { 'dhs status': () => [sessions.status()] });
        this.registerEvent(ctx, 'player-custom-payload-event', (_server, event: PlayerCustomPayloadEventData) => {
            if (event.channel !== CHANNEL) return;
            try {
                withPlayer(event.player, settings, (peer) => sessions.receive(peer, event.data));
            } catch (err) {
                sessions.left(event.player.getName());
                hostLogger.warn(`DistantHorizonsSupportPumpkin: cannot open DH session: ${String(err)}`);
            }
        });
        this.registerEvent(ctx, 'player-leave-event', (_server, event: PlayerLeaveEventData) =>
            sessions.left(event.player.getName())
        );
        this.registerEvent(ctx, 'server-tick-end-event', (server) =>
            sessions.tick(serverPeers(server, settings, hostLogger))
        );
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
        hostLogger.info(
            'DistantHorizonsSupportPumpkin: serving DH protocol 16 from loaded chunks and cached terrain. Distant chunk generation is unavailable; see the plugin README TODO.'
        );
    }
}
registerPlugin(new DistantHorizonsSupportPumpkin());

export { handleTask } from '@pumpkin-plugins/plugin-kit/plugin';
/** Dispatches plugin command handlers before delegating to Pumpkin's API package. */
export function handleCommand(id: number, sender: CommandSender, server: Server, args: ConsumedArgs): number {
    return runCommand(id, sender, args) ?? apiHandleCommand(id, sender, server, args);
}
export * from '@pumpkinmc/pumpkin-api-ts';
