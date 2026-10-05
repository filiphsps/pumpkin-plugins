import { commandInfos, type PluginInfo } from '@pumpkin-plugins/docs';
import { commands } from './commands/spec.ts';
import { configInfo } from './config/schema.ts';

/**
 * What the plugin is and offers. Feeds both its Pumpkin metadata and its generated README. Declare
 * commands with `defineCommands` and list them here with `commandInfos`, so they are documented from
 * what is registered (see docs/plugin-info-and-readmes.md).
 */
export const info = {
    name: 'DynamicLightsPumpkin',
    description: 'Server-driven dynamic lights for held items and nearby entities',
    permissions: [
        { name: 'fs.read.data', reason: 'Read its light-source settings, player preferences and old recovery data.' },
        {
            name: 'fs.write.data',
            reason: 'Write its light-source settings and player preferences, and clean up old recovery data.'
        }
    ],
    commands: commandInfos(commands),
    config: configInfo
} satisfies PluginInfo<'DynamicLightsPumpkin'>;
