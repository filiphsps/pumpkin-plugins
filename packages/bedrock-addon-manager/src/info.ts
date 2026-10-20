import { commandInfos, type PluginInfo } from '@pumpkin-plugins/docs';
import { commands } from './commands/spec.ts';
import { configInfo } from './config/schema.ts';
import { PLUGIN_NAME } from './name.ts';

/** Plugin metadata used by Pumpkin and the generated README. */
export const info = {
    name: PLUGIN_NAME,
    description:
        'BedrockAddonManager hosts Bedrock resource packs over HTTP, reads their manifests and prints the `pumpkin.toml` block that makes Pumpkin offer them to players.',
    permissions: [
        { name: 'fs.read.data', reason: 'Read the packs folder and the plugin config in its data folder.' },
        {
            name: 'fs.write.data',
            reason: 'Create and update the config, and write the resource packs found in `.mcaddon` files.',
        },
        { name: 'network.tcp.bind', reason: 'Listen for pack downloads from Bedrock clients.' },
    ],
    commands: commandInfos(commands),
    config: configInfo,
} satisfies PluginInfo<typeof PLUGIN_NAME>;
