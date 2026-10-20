import type { PluginMetadata } from 'pumpkin:plugin/metadata@0.1.0';
import { Plugin, registerPlugin } from '@pumpkin-plugins/pumpkin-api';

class StarterPlugin extends Plugin {
    metadata(): PluginMetadata {
        return {
            name: '__PLUGIN_NAME__',
            version: __PLUGIN_VERSION__,
            authors: [],
            description: 'A Pumpkin plugin.',
            dependencies: [],
            permissions: [],
        };
    }
}

registerPlugin(new StarterPlugin());

export * from '@pumpkin-plugins/pumpkin-api';
