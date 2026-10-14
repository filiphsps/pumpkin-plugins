import { defineCommands } from '@pumpkin-plugins/docs';
import { PLUGIN_NAME } from '../name.ts';

const operatorOnly = { tag: 'op', val: 'three' } as const;

/** Command declarations and permission nodes for TabDisplay. */
export const commands = defineCommands(PLUGIN_NAME, {
    tabdisplay: {
        description: 'Inspect and reload TabDisplay',
        permission: `${PLUGIN_NAME}:command`,
        defaultPermission: operatorOnly,
        subcommands: {
            status: {
                description: 'Show provider state and display capabilities',
                permission: `${PLUGIN_NAME}:command.status`,
                defaultPermission: operatorOnly,
            },
            reload: {
                description: 'Validate and atomically reload config.toml',
                permission: `${PLUGIN_NAME}:command.reload`,
                defaultPermission: operatorOnly,
            },
            inspect: {
                description: 'Inspect safe context for one online player',
                permission: `${PLUGIN_NAME}:command.inspect`,
                defaultPermission: operatorOnly,
                arguments: [{ name: 'player', type: 'players' }],
            },
        },
    },
});
