import { defineCommands } from '@pumpkin-plugins/docs';
import { PLUGIN_NAME } from '../name.ts';

/** Permission node required to run the `/baddon` commands. Pumpkin requires nodes to start with the plugin's name. */
export const COMMAND_PERMISSION = `${PLUGIN_NAME}:command.baddon` as const;

/** The plugin's commands. They are registered and documented from this one declaration. */
export const commands = defineCommands(PLUGIN_NAME, {
    baddon: {
        description: 'Manage Bedrock resource packs',
        permission: COMMAND_PERMISSION,
        subcommands: {
            list: {
                description: 'List detected packs and their effective settings',
                permission: `${COMMAND_PERMISSION}.list`,
                defaultPermission: { tag: 'allow' }
            },
            reload: {
                description: 'Reload `config.toml` and rescan the packs folder',
                permission: `${COMMAND_PERMISSION}.reload`
            }
        }
    }
});
