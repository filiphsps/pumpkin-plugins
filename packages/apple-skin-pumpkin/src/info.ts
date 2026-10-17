import type { PluginInfo } from '@pumpkin-plugins/docs';
import { PLUGIN_NAME } from './name.ts';

/**
 * Plugin metadata used by Pumpkin and the generated README.
 */
export const info = {
    name: PLUGIN_NAME,
    description: 'The plugin syncs saturation and exhaustion so AppleSkin can show accurate food stats.',
    permissions: [],
    commands: [],
} satisfies PluginInfo<typeof PLUGIN_NAME>;
