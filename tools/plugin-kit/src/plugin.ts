import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type { PluginMetadata } from 'pumpkin:plugin/metadata@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { type PluginInfo, pluginMetadata } from '@pumpkin-plugins/docs';
import { registerPluginWithUpdates } from '@pumpkin-plugins/update-check';
import { handleTask as apiHandleTask, Plugin } from '@pumpkinmc/pumpkin-api-ts';
import { runTask, scheduleDelayed } from './host.ts';

/** Base class for plugins, keeping metadata, lifecycle hooks, logging and update checks consistent. */
export abstract class PluginBase extends Plugin {
    /** The plugin's README and metadata declaration. */
    readonly info: PluginInfo;

    private readonly version: string;

    /** Creates a plugin from its shared info declaration and package version. */
    protected constructor(info: PluginInfo, version: string) {
        super();
        this.info = info;
        this.version = version;
    }

    /** Builds Pumpkin's plugin metadata from the shared info declaration. */
    metadata(): PluginMetadata {
        return pluginMetadata(this.info, this.version);
    }

    /** Registers the API's pending events and runs the plugin's load hook. */
    onLoad(ctx: Context): void {
        super.onLoad(ctx);
        this.onPluginLoad(ctx);
    }

    /** Runs the plugin's unload hook after the API's unload handler. */
    onUnload(ctx: Context): void {
        super.onUnload(ctx);
        this.onPluginUnload(ctx);
    }

    /** Implements the plugin-specific work performed when Pumpkin loads the plugin. */
    protected abstract onPluginLoad(ctx: Context): void;

    /** Implements plugin-specific cleanup when Pumpkin unloads the plugin. */
    protected onPluginUnload(_ctx: Context): void {}
}

/** Registers a plugin and enables its automatic Pumpkin Market update check. */
export function registerPlugin(plugin: PluginBase): void {
    registerPluginWithUpdates(plugin, plugin.info, {
        schedule: (callback) => scheduleDelayed(1, () => callback())
    });
}

/** Dispatches shared scheduled tasks before falling back to the Pumpkin API's handlers.
 * @param id - The scheduled handler id.
 * @param server - The server instance.
 */
export function handleTask(id: number, server: Server): void {
    if (!runTask(id, server)) apiHandleTask(id, server);
}
