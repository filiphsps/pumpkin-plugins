import type { CommandSender, ConsumedArgs } from 'pumpkin:plugin/command@0.1.0';
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { ipcSend } from '@pumpkin-plugins/plugin-kit/ipc';
import { PluginBase, registerPlugin } from '@pumpkin-plugins/plugin-kit/plugin';
import { handleCommand as apiHandleCommand } from '@pumpkinmc/pumpkin-api-ts';
import { registerCommands } from './commands/register.ts';
import { info } from './info.ts';
import { PackManager } from './manager.ts';
import { WasiDataDir } from './platform/data-dir.ts';
import { cancelTask, hostLogger, runCommand, scheduleRepeating } from './platform/host.ts';
import { TcpWebServer } from './web/tcp-server.ts';

/** Serves Bedrock resource packs over HTTP. */
class BedrockAddonManager extends PluginBase {
    private manager: PackManager | undefined;
    private tickTask: number | undefined;

    constructor() {
        super(info, __PLUGIN_VERSION__);
    }

    /** Starts the pack manager, schedules its tick and registers the `/baddon` commands. */
    protected onPluginLoad(ctx: Context): void {
        const files = WasiDataDir.open();
        if (!files) {
            hostLogger.error(
                `${info.name} cannot reach its data folder. Grant it the fs.read.data and fs.write.data permissions and restart the server.`
            );
            return;
        }

        const manager = new PackManager(
            files,
            hostLogger,
            (index) => new TcpWebServer((name) => index.open(name), hostLogger),
            ipcSend
        );
        manager.start();
        this.manager = manager;
        this.tickTask = scheduleRepeating(1, () => manager.tick());
        registerCommands(ctx, manager);
    }

    /** Stops the tick and the web server. */
    protected override onPluginUnload(_ctx: Context): void {
        if (this.tickTask !== undefined) cancelTask(this.tickTask);
        this.manager?.stop({ releasePort: false });
    }
}

registerPlugin(new BedrockAddonManager());

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

export * from '@pumpkinmc/pumpkin-api-ts';
