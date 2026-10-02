import { commandInfos, type PluginInfo } from '@pumpkin-plugins/docs';
import { commands } from './commands/spec.ts';
import { configInfo } from './config/schema.ts';
import { PLUGIN_NAME } from './name.ts';

/** What the plugin is, what it needs and what it offers. Feeds both its Pumpkin metadata and its README. */
export const info = {
    name: PLUGIN_NAME,
    description:
        "Serves Bedrock `.mcpack` and `.mcaddon` resource packs over HTTP and adds them to what connecting players are offered, using each pack's own manifest.",
    permissions: [
        { name: 'fs.read.data', reason: 'Read the packs folder and the plugin config in its data folder.' },
        {
            name: 'fs.write.data',
            reason: 'Create and update the config, and write the resource packs found in `.mcaddon` files.'
        },
        { name: 'network.tcp.bind', reason: 'Listen for pack downloads from Bedrock clients.' }
    ],
    commands: commandInfos(commands),
    config: configInfo
} satisfies PluginInfo<typeof PLUGIN_NAME>;
