import type { PluginInfo } from '@pumpkin-plugins/docs';

/**
 * What the plugin is and offers. Feeds both its Pumpkin metadata and its generated README. Declare
 * commands with `defineCommands` and list them here with `commandInfos`, so they are documented from
 * what is registered (see docs/plugin-info-and-readmes.md).
 */
export const info = {
    name: 'DistantHorizonsSupportPumpkin',
    description: 'Unofficial Distant Horizons server support for Pumpkin',
    permissions: [],
    commands: []
} satisfies PluginInfo<'DistantHorizonsSupportPumpkin'>;
