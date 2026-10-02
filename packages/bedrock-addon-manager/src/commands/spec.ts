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
            list: { description: 'List the packs found, with the settings each one gets' },
            reload: {
                description: 'Reload `config.toml`, rescan the packs folder and update the packs players are offered'
            }
        }
    }
});
