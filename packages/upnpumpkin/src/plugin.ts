import type { Context } from 'pumpkin:plugin/context@0.1.0';
import { ansi } from '@pumpkin-plugins/minecraft-colors';
import { WasiDataDir } from '@pumpkin-plugins/plugin-kit/data-dir';
import { cancelTask, hostLogger, scheduleRepeating } from '@pumpkin-plugins/plugin-kit/host';
import { taggedLogger } from '@pumpkin-plugins/plugin-kit/logger';
import { PluginBase, registerPlugin } from '@pumpkin-plugins/plugin-kit/plugin';
import { handleIpcMessage as apiHandleIpcMessage } from '@pumpkin-plugins/pumpkin-api';
import { registerCommands } from './commands/register.ts';
import { PortForwarder } from './forwarder.ts';
import { info } from './info.ts';
import { WasiNetwork } from './platform/wasi-network.ts';
import { wasiSockets } from './platform/wasi-sockets.ts';

const log = taggedLogger(`${ansi.named.name(info.name)}:`, hostLogger);
let forwarder: PortForwarder | undefined;

/** Opens ports on the router with UPnP and NAT-PMP, for the server itself and for other plugins. */
class UPnPumpkin extends PluginBase {
    private dataDir: WasiDataDir | undefined;
    private activeForwarder: PortForwarder | undefined;
    private tickTask: number | undefined;

    constructor() {
        super(info, __PLUGIN_VERSION__);
    }

    /** Starts the forwarder, schedules its tick and registers the `/upnp` commands. */
    protected onPluginLoad(ctx: Context): void {
        const files = WasiDataDir.open();
        if (!files) {
            log.error(
                'Cannot reach the data folder. Grant this plugin the fs.read.data and fs.write.data permissions and restart the server.',
            );
            return;
        }

        this.dataDir = files;
        try {
            const started = new PortForwarder(files, log, new WasiNetwork(wasiSockets));
            this.activeForwarder = started;
            started.start();
            forwarder = started;
            this.tickTask = scheduleRepeating(1, () => started.tick());
            registerCommands(ctx, started);
        } catch (error) {
            this.releaseResources();
            throw error;
        }
    }

    /** Stops the tick, closes the ports and disposes the data directory. */
    protected override onPluginUnload(_ctx: Context): void {
        this.releaseResources();
    }

    private releaseResources(): void {
        const task = this.tickTask;
        try {
            if (task !== undefined) cancelTask(task);
            this.tickTask = undefined;
        } finally {
            const started = this.activeForwarder;
            this.activeForwarder = undefined;
            const files = this.dataDir;
            this.dataDir = undefined;
            if (started !== undefined && forwarder === started) forwarder = undefined;
            try {
                started?.stop();
            } finally {
                files?.[Symbol.dispose]();
            }
        }
    }
}

registerPlugin(new UPnPumpkin());

export { handleCommand, handleTask } from '@pumpkin-plugins/plugin-kit/plugin';

/**
 * Answers a message from another plugin: a request to open a port, or to report on one.
 * @param sender - The plugin that sent it.
 * @param message - The message, in the format of `@pumpkin-plugins/upnpumpkin-api`.
 * @returns The reply.
 */
export function handleIpcMessage(sender: string, message: Uint8Array): Uint8Array {
    return forwarder ? forwarder.handleMessage(sender, message) : apiHandleIpcMessage(sender, message);
}

export * from '@pumpkin-plugins/pumpkin-api';
