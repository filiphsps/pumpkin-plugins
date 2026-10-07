import { defineCommands } from '@pumpkin-plugins/docs';
import { PLUGIN_NAME } from '../name.ts';

/** Permission node required to use the `/plugin` command. */
export const COMMAND_PERMISSION = `${PLUGIN_NAME}:command.plugin` as const;

/** The starter command, registered and documented from this declaration. */
export const commands = defineCommands(PLUGIN_NAME, {
    plugin: {
        description: 'Check that the plugin is running',
        permission: COMMAND_PERMISSION
    }
});
