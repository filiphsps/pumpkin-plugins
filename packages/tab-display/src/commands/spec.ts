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
                description: 'Show PumpkinPIE state, players and recent problems',
                permission: `${PLUGIN_NAME}:command.status`,
                defaultPermission: operatorOnly,
            },
            reload: {
                description: 'Reload config.toml',
                permission: `${PLUGIN_NAME}:command.reload`,
                defaultPermission: operatorOnly,
            },
            inspect: {
                description: "Show a player's placeholder IDs",
                permission: `${PLUGIN_NAME}:command.inspect`,
                defaultPermission: operatorOnly,
                arguments: [{ name: 'player', type: 'players' }],
            },
        },
    },
});
