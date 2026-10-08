import type { CommandSender, ConsumedArgs } from 'pumpkin:plugin/command@0.1.0';
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type {
    PlayerChangedWorldEventData,
    PlayerJoinEventData,
    PlayerLeaveEventData
} from 'pumpkin:plugin/event@0.1.0';
import * as logging from 'pumpkin:plugin/logging@0.1.0';
import type { Player } from 'pumpkin:plugin/player@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { TextComponent } from 'pumpkin:plugin/text@0.1.0';
import * as uuid from 'pumpkin:plugin/uuid@0.1.0';
import { WasiDataDir } from '@pumpkin-plugins/plugin-kit/data-dir';
import { runCommand } from '@pumpkin-plugins/plugin-kit/host';
import { PluginBase, registerPlugin } from '@pumpkin-plugins/plugin-kit/plugin';
import { registerCommands } from '@pumpkin-plugins/plugin-kit/register-commands';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import { handleCommand as apiHandleCommand } from '@pumpkinmc/pumpkin-api-ts';
import type { JavaLocatorRecipient } from './adapters/java-locator-bar.ts';
import type { LocatorOutputRegistry } from './adapters/locator-output-registry.ts';
import { createLocatorOutputRegistry } from './adapters/locator-output-registry.ts';
import { MapDeliveryService, waypointMapAdapters } from './adapters/map-delivery.ts';
import { commandHandlers } from './commands/handlers.ts';
import { ADMIN_PERMISSION, commands } from './commands/spec.ts';
import { info } from './info.ts';
import { WaypointService } from './waypoints/service.ts';
import { WaypointStore } from './waypoints/store.ts';

/** The server-owned waypoint service and its connected-client output lifecycle. */
class Waypoints extends PluginBase {
    private server: Server | undefined;
    private outputs: LocatorOutputRegistry | undefined;

    constructor() {
        super(info, __PLUGIN_VERSION__);
    }

    /** Loads persistent waypoint state and registers commands and recipient lifecycle events. */
    protected onPluginLoad(ctx: Context): void {
        const files = WasiDataDir.open();
        if (files === undefined) {
            logging.log('error', `${info.name} needs its data-folder permissions to run`);
            return;
        }

        const server = ctx.getServer();
        this.server = server;
        const store = new WaypointStore(files, {
            error: (message) => logging.log('error', `${info.name}: ${message}`)
        });
        const waypoints = new WaypointService(store, () => this.reconcileConnectedPlayers());
        const outputs = createLocatorOutputRegistry(waypoints, (id) => uuid.parse(id));
        this.outputs = outputs;

        registerCommands(
            ctx,
            commands,
            commandHandlers({
                server,
                waypoints,
                mapDelivery: new MapDeliveryService(waypoints, waypointMapAdapters),
                createWaypointId: () => uuid.toString(uuid.generate()),
                uuidToString: uuid.toString,
                sendSystemMessage: (player, message) =>
                    player.sendSystemMessage(TextComponent.fromLegacyString(message), false)
            })
        );

        this.registerEvent(ctx, 'server-load-event', (loadedServer) => this.reconcileAll(loadedServer, true));
        this.registerEvent(ctx, 'player-join-event', (_server, event: PlayerJoinEventData) =>
            this.reconcilePlayer(event.player, true)
        );
        this.registerEvent(ctx, 'player-changed-world-event', (_server, event: PlayerChangedWorldEventData) =>
            this.reconcilePlayer(event.player, true)
        );
        this.registerEvent(ctx, 'player-leave-event', (_server, event: PlayerLeaveEventData) => {
            outputs['java:locator-bar']?.forgetPlayer(uuid.toString(event.player.getId()));
        });
        this.reconcileAll(server, true);
    }

    /** Removes active markers before releasing the retained server handle. */
    protected override onPluginUnload(_ctx: Context): void {
        const server = this.server;
        try {
            if (server !== undefined) this.reconcileAll(server, false, true);
        } finally {
            disposeWasiResource(server);
            this.server = undefined;
            this.outputs = undefined;
        }
    }

    private reconcileConnectedPlayers(): void {
        const server = this.server;
        if (server !== undefined) this.reconcileAll(server, false);
    }

    private reconcileAll(server: Server, forceReset: boolean, clear = false): void {
        let players: Player[];
        try {
            players = server.getAllPlayers();
        } catch (error) {
            logging.log('warn', `${info.name}: could not list online players for locator update: ${String(error)}`);
            return;
        }
        try {
            for (const player of players) {
                try {
                    this.reconcilePlayer(player, forceReset, clear);
                } catch (error) {
                    logging.log('warn', `${info.name}: could not update a player's locator markers: ${String(error)}`);
                }
            }
        } finally {
            for (const player of players) disposeWasiResource(player);
        }
    }

    private reconcilePlayer(player: Player, forceReset: boolean, clear = false): void {
        const output = this.outputs?.['java:locator-bar'];
        if (output === undefined) return;

        const playerId = uuid.toString(player.getId());
        const javaPlayer = player.asJava() ?? undefined;
        if (javaPlayer === undefined) {
            output.forgetPlayer(playerId);
            return;
        }
        try {
            const world = player.getWorld();
            try {
                const recipient: JavaLocatorRecipient = {
                    playerId,
                    dimension: world.getName(),
                    isJava: true,
                    isOperator: player.hasPermission(ADMIN_PERMISSION),
                    sendPacket: (packet) => javaPlayer.sendPacket(packet)
                };
                if (clear) output.clear(recipient);
                else output.reconcile(recipient, forceReset);
            } finally {
                disposeWasiResource(world);
            }
        } finally {
            disposeWasiResource(javaPlayer);
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
