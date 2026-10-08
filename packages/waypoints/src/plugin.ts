import type { CommandSender, ConsumedArgs } from 'pumpkin:plugin/command@0.1.0';
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type {
    PlayerChangedWorldEventData,
    PlayerJoinEventData,
    PlayerLeaveEventData
} from 'pumpkin:plugin/event@0.1.0';
import { ItemStack } from 'pumpkin:plugin/item-stack@0.1.0';
import * as logging from 'pumpkin:plugin/logging@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import * as uuid from 'pumpkin:plugin/uuid@0.1.0';
import { WasiDataDir } from '@pumpkin-plugins/plugin-kit/data-dir';
import { runCommand } from '@pumpkin-plugins/plugin-kit/host';
import { PluginBase, registerPlugin } from '@pumpkin-plugins/plugin-kit/plugin';
import { registerCommands } from '@pumpkin-plugins/plugin-kit/register-commands';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import { handleCommand as apiHandleCommand } from '@pumpkinmc/pumpkin-api-ts';
import { commandHandlers } from './commands/handlers.ts';
import { commands } from './commands/spec.ts';
import { info } from './info.ts';
import { WaypointHudService } from './rendering/pumpkin-hud.ts';
import { WaypointCatalog } from './waypoints/catalog.ts';
import { normalizeItemIdentifier } from './waypoints/model.ts';
import { WaypointStore } from './waypoints/store.ts';

/** The canonical waypoint catalog and its vanilla command surface. */
class Waypoints extends PluginBase {
    private server: Server | undefined;
    private files: WasiDataDir | undefined;
    private hud: WaypointHudService | undefined;

    constructor() {
        super(info, __PLUGIN_VERSION__);
    }

    /** Loads persistent waypoint resources and registers their commands. */
    protected onPluginLoad(ctx: Context): void {
        const files = WasiDataDir.open();
        if (files === undefined) {
            logging.log('error', `${info.name} needs its data-folder permissions to run`);
            return;
        }

        const server = ctx.getServer();
        this.server = server;
        this.files = files;
        const store = new WaypointStore(files, {
            error: (message) => logging.log('error', `${info.name}: ${message}`),
            warn: (message) => logging.log('warn', `${info.name}: ${message}`)
        });
        const catalog = new WaypointCatalog(store);
        const hud = new WaypointHudService(server, catalog, {
            onError: (viewerId, error) =>
                logging.log('warn', `${info.name}: waypoint HUD update failed for ${viewerId}: ${String(error)}`)
        });
        this.hud = hud;

        this.registerEvent(ctx, 'server-tick-end-event', () => hud.tick());
        this.registerEvent(ctx, 'player-join-event', (_server, event: PlayerJoinEventData) => hud.joined(event.player));
        this.registerEvent(ctx, 'player-changed-world-event', (_server, event: PlayerChangedWorldEventData) =>
            hud.changedWorld(event.player)
        );
        this.registerEvent(ctx, 'player-leave-event', (_server, event: PlayerLeaveEventData) => hud.left(event.player));

        registerCommands(
            ctx,
            commands,
            commandHandlers({
                server,
                catalog,
                createWaypointId: () => uuid.toString(uuid.generate()),
                uuidToString: uuid.toString,
                uuidFromString: uuid.parse,
                validateItemIcon: (key) => {
                    let stack: ItemStack | undefined;
                    try {
                        const requestedKey = normalizeItemIdentifier(key);
                        stack = new ItemStack(requestedKey, 1);
                        return normalizeItemIdentifier(stack.getRegistryKey()) === requestedKey;
                    } catch {
                        return false;
                    } finally {
                        disposeWasiResource(stack);
                    }
                }
            })
        );
    }

    /** Releases retained Pumpkin and filesystem handles on plugin unload. */
    protected override onPluginUnload(_ctx: Context): void {
        try {
            this.hud?.unload();
        } finally {
            this.hud = undefined;
            disposeWasiResource(this.server);
            this.server = undefined;
            disposeWasiResource(this.files);
            this.files = undefined;
        }
    }
}

registerPlugin(new Waypoints());

export { handleTask } from '@pumpkin-plugins/plugin-kit/plugin';

/** Dispatches waypoint command handlers before delegating to Pumpkin's API package. */
export function handleCommand(id: number, sender: CommandSender, server: Server, args: ConsumedArgs): number {
    return runCommand(id, sender, args) ?? apiHandleCommand(id, sender, server, args);
}

export * from '@pumpkinmc/pumpkin-api-ts';
