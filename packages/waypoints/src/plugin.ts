import type { CommandSender, ConsumedArgs } from 'pumpkin:plugin/command@0.1.0';
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { runCommand } from '@pumpkin-plugins/plugin-kit/host';
import { PluginBase, registerPlugin } from '@pumpkin-plugins/plugin-kit/plugin';
import { registerCommands } from '@pumpkin-plugins/plugin-kit/register-commands';
import { handleCommand as apiHandleCommand } from '@pumpkinmc/pumpkin-api-ts';
import { commands } from './commands/spec.ts';
import { info } from './info.ts';
import { PLUGIN_NAME } from './name.ts';

/** The plugin. Pumpkin creates it once and calls `onLoad` when the server starts. */
class Waypoints extends PluginBase {
    constructor() {
        super(info, __PLUGIN_VERSION__);
    }

    /** Runs plugin-specific setup when the server loads the plugin. */
    protected onPluginLoad(ctx: Context): void {
        registerCommands(ctx, commands, { plugin: () => [`${PLUGIN_NAME} is running.`] });
    }
}

registerPlugin(new Waypoints());

export { handleTask } from '@pumpkin-plugins/plugin-kit/plugin';

/** Dispatches starter command handlers before delegating to Pumpkin's API package. */
export function handleCommand(id: number, sender: CommandSender, server: Server, args: ConsumedArgs): number {
    return runCommand(id, sender, args) ?? apiHandleCommand(id, sender, server, args);
}

export * from '@pumpkinmc/pumpkin-api-ts';
