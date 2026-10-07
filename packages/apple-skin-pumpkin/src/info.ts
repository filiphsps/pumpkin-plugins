import type { PluginInfo } from '@pumpkin-plugins/docs';
import { PLUGIN_NAME } from './name.ts';

/**
 * Plugin metadata used by Pumpkin and the generated README.
 */
export const info = {
    name: PLUGIN_NAME,
    description: 'AppleSkin server-side support',
    permissions: [],
    commands: []
} satisfies PluginInfo<typeof PLUGIN_NAME>;
