import { defineCommands } from '@pumpkin-plugins/docs';
import { PLUGIN_NAME } from '../name.ts';

/** Permission node required to run the `/upnp` commands. Pumpkin requires nodes to start with the plugin's name. */
export const COMMAND_PERMISSION = `${PLUGIN_NAME}:command.upnp` as const;

/** The plugin's commands. They are registered and documented from this one declaration. */
export const commands = defineCommands(PLUGIN_NAME, {
    upnp: {
        description: 'Manage port forwarding',
        permission: COMMAND_PERMISSION,
        subcommands: {
            status: { description: 'Show the router that was found and every port that is open or being opened' },
            reload: { description: 'Reload `config.toml` and update the open ports' }
        }
    }
});
