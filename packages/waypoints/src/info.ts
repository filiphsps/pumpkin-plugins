import { commandInfos, type PluginInfo } from '@pumpkin-plugins/docs';
import { commands } from './commands/spec.ts';
import { PLUGIN_NAME } from './name.ts';

/**
 * What the plugin is and offers. Feeds both its Pumpkin metadata and its generated README. Declare
 * commands with `defineCommands` and list them here with `commandInfos`, so they are documented from
 * what is registered (see docs/plugin-info-and-readmes.md).
 */
export const info = {
    name: PLUGIN_NAME,
    description: 'Server waypoints with vanilla commands and Java Locator Bar',
    permissions: [
        { name: 'fs.read.data', reason: 'Read the waypoint store from the plugin data folder.' },
        { name: 'fs.write.data', reason: 'Persist waypoint changes in the plugin data folder.' }
    ],
    commands: commandInfos(commands)
} satisfies PluginInfo<typeof PLUGIN_NAME>;
