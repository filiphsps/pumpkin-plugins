import { commandInfos, type PluginInfo } from '@pumpkin-plugins/docs';
import { commands } from './commands/spec.ts';
import { configInfo } from './config/schema.ts';
import { PLUGIN_NAME } from './name.ts';

/**
 * Plugin metadata used by Pumpkin and the generated README.
 */
export const info = {
    name: PLUGIN_NAME,
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
} satisfies PluginInfo<typeof PLUGIN_NAME>;
