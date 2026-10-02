import type { Context } from 'pumpkin:plugin/context@0.1.0';
import { registerCommands as register } from '@pumpkin-plugins/plugin-kit/register-commands';
import type { PortForwarder } from '../forwarder.ts';
import { commandHandlers } from './handlers.ts';
import { commands } from './spec.ts';

/**
 * Registers `/upnp status` and `/upnp reload`. Operators of level 3 and the console may use them.
 * @param ctx - The plugin context.
 * @param forwarder - What the commands report on and control.
 */
export function registerCommands(ctx: Context, forwarder: PortForwarder): void {
    register(ctx, commands, commandHandlers(forwarder));
}
