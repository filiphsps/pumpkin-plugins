import type { CommandSender, ConsumedArgs } from 'pumpkin:plugin/command@0.1.0';
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type {
    PlayerChangedWorldEventData,
    PlayerCommandSendEventData,
    PlayerJoinEventData,
    PlayerLeaveEventData,
    ServerCommandEventData
} from 'pumpkin:plugin/event@0.1.0';
import { ItemStack } from 'pumpkin:plugin/item-stack@0.1.0';
import * as logging from 'pumpkin:plugin/logging@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import * as uuid from 'pumpkin:plugin/uuid@0.1.0';
import { WasiDataDir } from '@pumpkin-plugins/plugin-kit/data-dir';
import { cancelTask, runCommand, scheduleRepeating } from '@pumpkin-plugins/plugin-kit/host';
import { PluginBase, registerPlugin } from '@pumpkin-plugins/plugin-kit/plugin';
import { registerCommands } from '@pumpkin-plugins/plugin-kit/register-commands';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import { handleCommand as apiHandleCommand } from '@pumpkinmc/pumpkin-api-ts';
import { commandHandlers } from './commands/handlers.ts';
import { itemIconInputFromCommand } from './commands/item-input.ts';
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
    private hudTaskId: number | undefined;
    private readonly pendingItemIconInputs = new Map<string, string>();
    private pendingServerItemIconInput: string | undefined;

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
        // Pumpkin disables scheduled plugin tasks before shutting down the WASM store.
        this.hudTaskId = scheduleRepeating(1, () => hud.tick());

        this.registerEvent(ctx, 'player-join-event', (_server, event: PlayerJoinEventData) => hud.joined(event.player));
        this.registerEvent(ctx, 'player-changed-world-event', (_server, event: PlayerChangedWorldEventData) =>
            hud.changedWorld(event.player)
        );
        this.registerEvent(ctx, 'player-command-send-event', (_server, event: PlayerCommandSendEventData) => {
            const playerKey = event.player.getName().toLowerCase();
            const itemInput = itemIconInputFromCommand(event.command);
            if (itemInput === undefined) this.pendingItemIconInputs.delete(playerKey);
            else this.pendingItemIconInputs.set(playerKey, itemInput);
        });
        this.registerEvent(ctx, 'server-command-event', (_server, event: ServerCommandEventData) => {
            this.pendingServerItemIconInput = itemIconInputFromCommand(event.command);
        });
        this.registerEvent(ctx, 'player-leave-event', (_server, event: PlayerLeaveEventData) => {
            this.pendingItemIconInputs.delete(event.player.getName().toLowerCase());
            hud.left(event.player);
        });

        registerCommands(
            ctx,
            commands,
            commandHandlers({
                server,
                catalog,
                createWaypointId: () => uuid.toString(uuid.generate()),
                uuidToString: uuid.toString,
                uuidFromString: uuid.parse,
                consumePendingItemIconInput: (sender) => {
                    if (sender.isPlayer()) {
                        const playerKey = sender.getName().toLowerCase();
                        const input = this.pendingItemIconInputs.get(playerKey);
                        this.pendingItemIconInputs.delete(playerKey);
                        return input;
                    }
                    const input = this.pendingServerItemIconInput;
                    this.pendingServerItemIconInput = undefined;
                    return input;
                },
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
        this.pendingItemIconInputs.clear();
        this.pendingServerItemIconInput = undefined;
        const hudTaskId = this.hudTaskId;
        this.hudTaskId = undefined;
        if (hudTaskId !== undefined) {
            try {
                cancelTask(hudTaskId);
            } catch (error) {
                logging.log('warn', `${info.name}: failed to cancel HUD update task: ${String(error)}`);
            }
        }
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
