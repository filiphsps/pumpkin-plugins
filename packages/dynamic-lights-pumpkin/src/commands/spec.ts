import { defineCommands } from '@pumpkin-plugins/docs';

/** Permission node required to use the `/dynamiclights` command. */
export const COMMAND_PERMISSION = 'DynamicLightsPumpkin:command.dynamiclights' as const;

/** Commands registered by DynamicLightsPumpkin. */
export const commands = defineCommands('DynamicLightsPumpkin', {
    dynamiclights: {
        description: 'Toggle dynamic lights for yourself',
        permission: COMMAND_PERMISSION,
        defaultPermission: { tag: 'allow' }
    }
});
