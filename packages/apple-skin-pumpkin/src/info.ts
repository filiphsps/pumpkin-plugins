import type { PluginInfo } from '@pumpkin-plugins/docs';
import { PLUGIN_NAME } from './name.ts';

/**
 * What the plugin is and offers. Feeds both its Pumpkin metadata and its generated README. Declare
 * commands with `defineCommands` and list them here with `commandInfos`, so they are documented from
 * what is registered (see docs/plugin-info-and-readmes.md).
 */
export const info = {
    name: PLUGIN_NAME,
    description: 'AppleSkin server-side support',
    permissions: [],
    commands: []
} satisfies PluginInfo<typeof PLUGIN_NAME>;
