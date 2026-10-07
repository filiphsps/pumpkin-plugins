import { defineCommands } from '@pumpkin-plugins/docs';
import { PLUGIN_NAME } from '../name.ts';

/** Permission node required to use the `/dynamiclights` command. */
export const COMMAND_PERMISSION = `${PLUGIN_NAME}:command.dynamiclights` as const;

/** Commands registered by DynamicLightsPumpkin. */
export const commands = defineCommands(PLUGIN_NAME, {
    dynamiclights: {
        description: 'Toggle dynamic lights for yourself',
        permission: COMMAND_PERMISSION,
        defaultPermission: { tag: 'allow' }
    }
});
