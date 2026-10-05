import type { Context } from 'pumpkin:plugin/context@0.1.0';
import { PluginBase, registerPlugin } from '@pumpkin-plugins/plugin-kit/plugin';
import { info } from './info.ts';

/** The plugin. Pumpkin creates it once and calls `onLoad` when the server starts. */
class DistantHorizonsSupportPumpkin extends PluginBase {
    constructor() {
        super(info, __PLUGIN_VERSION__);
    }

    /** Runs plugin-specific setup when the server loads the plugin. */
    protected onPluginLoad(_ctx: Context): void {}
}

registerPlugin(new DistantHorizonsSupportPumpkin());

export { handleTask } from '@pumpkin-plugins/plugin-kit/plugin';
export * from '@pumpkinmc/pumpkin-api-ts';
