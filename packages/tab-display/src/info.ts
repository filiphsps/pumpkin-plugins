import { commandInfos, type PluginInfo } from '@pumpkin-plugins/docs';
import { commands } from './commands/spec.ts';
import { configInfo } from './config.ts';
import { PLUGIN_NAME } from './name.ts';

/**
 * What the plugin is and offers. Feeds both its Pumpkin metadata and its generated README. Declare
 * commands with `defineCommands` and list them here with `commandInfos`, so they are documented from
 * what is registered (see docs/plugin-info-and-readmes.md).
 */
export const info = {
    name: PLUGIN_NAME,
    description: 'Customizes Java tab displays with native Bedrock capability gates',
    permissions: [
        { name: 'fs.read.data', reason: 'Read TabDisplay settings from the plugin data folder.' },
        { name: 'fs.write.data', reason: 'Create and update TabDisplay settings in the plugin data folder.' }
    ],
    commands: commandInfos(commands),
    config: configInfo
} satisfies PluginInfo<typeof PLUGIN_NAME>;
