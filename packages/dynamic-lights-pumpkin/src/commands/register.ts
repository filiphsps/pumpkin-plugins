import type { Context } from 'pumpkin:plugin/context@0.1.0';
import { registerCommands as register } from '@pumpkin-plugins/plugin-kit/register-commands';
import { commandHandlers, type PlayerLightToggler } from './handlers.ts';
import { commands } from './spec.ts';

/** Registers `/dynamiclights` for all players by default. */
export function registerCommands(ctx: Context, toggler: PlayerLightToggler): void {
    register(ctx, commands, commandHandlers(toggler), { defaultPermission: { tag: 'allow' } });
}
