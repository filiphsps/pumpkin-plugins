import { commandInfos, type PluginInfo } from '@pumpkin-plugins/docs';
import { commands } from './commands/spec.ts';
import { configInfo } from './config.ts';
import { PLUGIN_NAME } from './name.ts';

/** TabDisplay metadata and README source: data-folder permissions, commands and config settings. */
export const info = {
    name: PLUGIN_NAME,
    description: 'TabDisplay formats Java player-list names, headers, and footers. It leaves Bedrock lists unchanged.',
    permissions: [
        { name: 'fs.read.data', reason: 'Read TabDisplay settings from the plugin data folder.' },
        { name: 'fs.write.data', reason: 'Create and update TabDisplay settings in the plugin data folder.' },
    ],
    commands: commandInfos(commands),
    config: configInfo,
} satisfies PluginInfo<typeof PLUGIN_NAME>;
