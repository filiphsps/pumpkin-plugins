import type { CommandSender, ConsumedArgs } from 'pumpkin:plugin/command@0.1.0';
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { WasiDataDir } from '@pumpkin-plugins/plugin-kit/data-dir';
import { cancelTask, hostLogger, runCommand, scheduleRepeating } from '@pumpkin-plugins/plugin-kit/host';
import { PluginBase, registerPlugin } from '@pumpkin-plugins/plugin-kit/plugin';
import { handleCommand as apiHandleCommand, handleIpcMessage as apiHandleIpcMessage } from '@pumpkinmc/pumpkin-api-ts';
import { registerCommands } from './commands/register.ts';
import { PortForwarder } from './forwarder.ts';
import { info } from './info.ts';
import { WasiNetwork } from './platform/wasi-network.ts';
import { wasiSockets } from './platform/wasi-sockets.ts';

let forwarder: PortForwarder | undefined;

/** Opens ports on the router with UPnP and NAT-PMP, for the server itself and for other plugins. */
class UPnPumpkin extends PluginBase {
    private tickTask: number | undefined;

    constructor() {
        super(info, __PLUGIN_VERSION__);
    }

    /** Starts the forwarder, schedules its tick and registers the `/upnp` commands. */
    protected onPluginLoad(ctx: Context): void {
        const files = WasiDataDir.open();
        if (!files) {
            hostLogger.error(
                `${info.name} cannot reach its data folder. Grant it the fs.read.data and fs.write.data permissions and restart the server.`
            );
            return;
        }

        const started = new PortForwarder(files, hostLogger, new WasiNetwork(wasiSockets));
        started.start();
        forwarder = started;
        this.tickTask = scheduleRepeating(1, () => started.tick());
        registerCommands(ctx, started);
    }

    /** Stops the tick and closes the ports. */
    protected override onPluginUnload(_ctx: Context): void {
        if (this.tickTask !== undefined) cancelTask(this.tickTask);
        forwarder?.stop();
        forwarder = undefined;
    }
}

registerPlugin(new UPnPumpkin());

export { handleTask } from '@pumpkin-plugins/plugin-kit/plugin';

/**
 * Dispatches a command: this plugin's own handlers first, then the API package's.
 * @param id - The handler id.
 * @param sender - Who ran the command.
 * @param server - The server instance.
 * @param args - The consumed arguments.
 * @returns The command's success count.
 */
export function handleCommand(id: number, sender: CommandSender, server: Server, args: ConsumedArgs): number {
    return runCommand(id, sender, args) ?? apiHandleCommand(id, sender, server, args);
}

/**
 * Answers a message from another plugin: a request to open a port, or to report on one.
 * @param sender - The plugin that sent it.
 * @param message - The message, in the format of `@pumpkin-plugins/upnpumpkin-api`.
 * @returns The reply.
 */
export function handleIpcMessage(sender: string, message: Uint8Array): Uint8Array {
    return forwarder ? forwarder.handleMessage(sender, message) : apiHandleIpcMessage(sender, message);
}

export * from '@pumpkinmc/pumpkin-api-ts';
