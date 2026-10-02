import type { Context } from 'pumpkin:plugin/context@0.1.0';
import { registerCommands as register } from '@pumpkin-plugins/plugin-kit/register-commands';
import type { PackManager } from '../manager.ts';
import { commandHandlers } from './handlers.ts';
import { commands } from './spec.ts';

/**
 * Registers the `/baddon` commands. Operators of level 3 and the console may use them.
 * @param ctx - The plugin context.
 * @param manager - The manager the commands report on and control.
 */
export function registerCommands(ctx: Context, manager: PackManager): void {
    register(ctx, commands, commandHandlers(manager));
}
