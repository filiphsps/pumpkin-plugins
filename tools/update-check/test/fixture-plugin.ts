import type { PluginMetadata } from 'pumpkin:plugin/metadata@0.1.0';
import { Plugin } from '@pumpkinmc/pumpkin-api-ts';
import { registerPluginWithUpdates } from '../src/index.ts';

/** A real Pumpkin plugin that executes the update checker with a deterministic transport response. */
class UpdateCheckFixture extends Plugin {
    metadata(): PluginMetadata {
        return {
            name: 'UpdateCheckFixture',
            version: __PLUGIN_VERSION__,
            authors: [],
            description: 'Exercises update checking inside a Pumpkin plugin.',
            dependencies: [],
            permissions: ['http.outbound']
        };
    }
}

registerPluginWithUpdates(
    new UpdateCheckFixture(),
    {
        name: 'UpdateCheckFixture',
        description: 'Exercises automatic update checking inside a Pumpkin plugin.',
        permissions: [{ name: 'http.outbound', reason: 'Check for updates.' }]
    },
    {
        request: (url) => {
            if (!url.includes('plugin_name=UpdateCheckFixture')) throw new Error('unexpected update URL');
            return { latest_version: '1.3.0', update_available: true };
        }
    }
);

export * from '@pumpkinmc/pumpkin-api-ts';
