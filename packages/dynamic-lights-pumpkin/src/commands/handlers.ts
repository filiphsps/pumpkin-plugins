import type { CommandSender } from 'pumpkin:plugin/command@0.1.0';
import { type CommandHandlers, errorLine } from '@pumpkin-plugins/docs';
import type { commands } from './spec.ts';

/** Toggles dynamic lights for a player and returns whether they are enabled afterwards. */
export interface PlayerLightToggler {
    togglePlayerLights(player: NonNullable<ReturnType<CommandSender['asPlayer']>>): boolean;
}

/** Builds the handlers for DynamicLightsPumpkin commands. */
export function commandHandlers(toggler: PlayerLightToggler): CommandHandlers<typeof commands, CommandSender> {
    return {
        dynamiclights: (sender) => {
            const player = sender.asPlayer();
            if (player == null) return [errorLine('This command can only be used by a player.')];
            return [`Dynamic lights ${toggler.togglePlayerLights(player) ? 'enabled' : 'disabled'}.`];
        }
    };
}
