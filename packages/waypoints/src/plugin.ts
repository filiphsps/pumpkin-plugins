import type { CommandSender } from 'pumpkin:plugin/command@0.1.0';
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type {
    PlayerChangedWorldEventData,
    PlayerCommandSendEventData,
    PlayerJoinEventData,
    PlayerLeaveEventData,
    ServerCommandEventData,
} from 'pumpkin:plugin/event@0.1.0';
import type { IpcMessage, PluginId } from 'pumpkin:plugin/ipc@0.1.0';
import { ItemStack } from 'pumpkin:plugin/item-stack@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import * as uuid from 'pumpkin:plugin/uuid@0.1.0';
import { ansi } from '@pumpkin-plugins/minecraft-colors';
import { WasiDataDir } from '@pumpkin-plugins/plugin-kit/data-dir';
import { cancelTask, hostLogger, scheduleRepeating } from '@pumpkin-plugins/plugin-kit/host';
import { taggedLogger } from '@pumpkin-plugins/plugin-kit/logger';
import { PluginBase, registerPlugin } from '@pumpkin-plugins/plugin-kit/plugin';
import { registerCommands } from '@pumpkin-plugins/plugin-kit/register-commands';
import { monotonicMs } from '@pumpkin-plugins/plugin-kit/wasi-clock';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import {
    commandHandlers,
    onlinePlayerNameSuggestions,
    resetPropertySuggestions,
    waypointNameSuggestions,
} from './commands/handlers.ts';
import { itemIconInputFromCommand } from './commands/item-input.ts';
import { commands } from './commands/spec.ts';
import { info } from './info.ts';
import { WaypointPlaceholderService } from './placeholders/service.ts';
import { JAVA_DISPLAY_VERSION } from './rendering/java-version.ts';
import { WaypointHudService } from './rendering/pumpkin-hud.ts';
import { WaypointCatalog } from './waypoints/catalog.ts';
import { normalizeItemIdentifier } from './waypoints/model.ts';
import { WaypointStore } from './waypoints/store.ts';

const log = taggedLogger(`${ansi.named.name(info.name)}:`, hostLogger);

/** The canonical waypoint catalog and its vanilla command surface. */
class Waypoints extends PluginBase {
    private server: Server | undefined;
    private files: WasiDataDir | undefined;
    private hud: WaypointHudService | undefined;
    private placeholders: WaypointPlaceholderService | undefined;
    private tickTaskId: number | undefined;
    private readonly pendingItemIconInputs = new Map<string, string>();
    private pendingServerItemIconInput: string | undefined;

    constructor() {
        super(info, __PLUGIN_VERSION__);
    }

    /** Loads persistent waypoint resources and registers their commands. */
    protected onPluginLoad(ctx: Context): void {
        const files = WasiDataDir.open();
        if (files === undefined) {
            log.error('needs its data-folder permissions to run');
            return;
        }

        const server = ctx.getServer();
        this.server = server;
        this.files = files;
        const store = new WaypointStore(files, log);
        const catalog = new WaypointCatalog(store);
        const hud = new WaypointHudService(server, catalog, {
            onError: (viewerId, error) =>
                log.warn(`waypoint HUD update failed for ${ansi.named.uuid(viewerId)}: ${String(error)}`),
            onUnsupportedVersion: (viewerId, version) =>
                log.info(
                    `no waypoint HUD for ${ansi.named.uuid(viewerId)}: client version ${ansi.named.value(version)}, HUD needs ${ansi.named.value(JAVA_DISPLAY_VERSION)}`,
                ),
        });
        this.hud = hud;
        this.placeholders = new WaypointPlaceholderService(server, catalog, {
            now: monotonicMs,
            onTransition: (state) => log.info(`PumpkinPIE provider is ${ansi.named.value(state.kind)}`),
            onFailure: (identifier, reason) =>
                log.warn(`waypoint placeholder ${ansi.named.identifier(identifier)} declined (${reason})`),
        });
        // Pumpkin disables scheduled plugin tasks before shutting down the WASM store.
        this.tickTaskId = scheduleRepeating(1, () => this.tick());

        this.registerEvent(ctx, 'player-join-event', (_server, event: PlayerJoinEventData) => {
            hud.joined(event.player);
        });
        this.registerEvent(ctx, 'player-changed-world-event', (_server, event: PlayerChangedWorldEventData) => {
            hud.changedWorld(event.player);
        });
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

        const commandRuntime = {
            server,
            catalog,
            createWaypointId: () => uuid.toString(uuid.generate()),
            uuidToString: uuid.toString,
            uuidFromString: uuid.parse,
            consumePendingItemIconInput: (sender: CommandSender) => {
                if (sender.isPlayer()) {
                    const playerKey = sender.getName().toLowerCase();
                    const input = this.pendingItemIconInputs.get(playerKey);
                    this.pendingItemIconInputs.delete(playerKey);
                    return input;
                }
                // RCON commands fire no event the plugin can read, so only the console has an input.
                if (!sender.isConsole()) return undefined;
                const input = this.pendingServerItemIconInput;
                this.pendingServerItemIconInput = undefined;
                return input;
            },
            validateItemIcon: (key: string) => {
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
            },
        };
        registerCommands(ctx, commands, commandHandlers(commandRuntime), {
            arguments: {
                name: waypointNameSuggestions(commandRuntime),
                player: onlinePlayerNameSuggestions(commandRuntime),
                property: resetPropertySuggestions,
            },
            register: (handler) => this.registerCommandSuggestionHandler(handler),
        });
    }

    /** Releases retained Pumpkin and filesystem handles on plugin unload. */
    protected override onPluginUnload(_ctx: Context): void {
        this.pendingItemIconInputs.clear();
        this.pendingServerItemIconInput = undefined;
        const tickTaskId = this.tickTaskId;
        this.tickTaskId = undefined;
        if (tickTaskId !== undefined) {
            try {
                cancelTask(tickTaskId);
            } catch (error) {
                log.warn(`failed to cancel update task: ${String(error)}`);
            }
        }

        const placeholders = this.placeholders;
        this.placeholders = undefined;
        try {
            placeholders?.stop();
        } catch {
            log.warn('failed to stop PumpkinPIE session');
        }

        const hud = this.hud;
        this.hud = undefined;
        try {
            hud?.unload();
        } catch {
            log.warn('failed to unload waypoint HUD');
        }

        const resources = [this.server, this.files];
        this.server = undefined;
        this.files = undefined;
        for (const resource of resources) {
            try {
                disposeWasiResource(resource);
            } catch {
                log.warn('failed to release a host resource during unload');
            }
        }
    }

    /** Routes PumpkinPIE callbacks through the session's authenticated expansion router. */
    override handleIpcMessage(sender: PluginId, message: IpcMessage): IpcMessage {
        const placeholders = this.placeholders;
        return placeholders === undefined
            ? super.handleIpcMessage(sender, message)
            : placeholders.handleIpcMessage(sender, message);
    }

    private tick(): void {
        try {
            this.placeholders?.tick();
        } catch {
            log.warn('PumpkinPIE session tick failed');
        }
        try {
            this.hud?.tick();
        } catch {
            log.warn('waypoint HUD tick failed');
        }
    }
}

registerPlugin(new Waypoints());

export { handleCommand, handleTask } from '@pumpkin-plugins/plugin-kit/plugin';

export * from '@pumpkin-plugins/pumpkin-api';
