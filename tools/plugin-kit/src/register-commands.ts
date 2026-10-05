import { Command, CommandNode, type CommandSender } from 'pumpkin:plugin/command@0.1.0';
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type { PermissionDefault } from 'pumpkin:plugin/permission@0.1.0';
import { TextComponent } from 'pumpkin:plugin/text@0.1.0';
import type { CommandHandlers, CommandTree } from '@pumpkin-plugins/docs';
import { buildCommands, type CommandHost } from './commands.ts';
import { onCommand } from './host.ts';

/** Options that control how a plugin's commands are registered. */
export interface RegisterCommandsOptions {
    /** Permission default used for every node, which is operator level three by default. */
    readonly defaultPermission?: PermissionDefault;
}

function text(line: string, tone?: 'error'): TextComponent {
    const component = TextComponent.text(line);
    if (tone === 'error') component.colorNamed('red');
    return component;
}

/**
 * Registers a plugin's commands and their permissions with the server. Operators of level 3 and
 * the console may use them by default.
 * @param ctx - The plugin context.
 * @param tree - The commands, from `defineCommands`.
 * @param handlers - What runs each command: the lines to send back, or a thrown `CommandFailed`.
 * @param options - Permission behavior for the registered command nodes.
 */
export function registerCommands<T extends CommandTree>(
    ctx: Context,
    tree: T,
    handlers: CommandHandlers<T, CommandSender>,
    options: RegisterCommandsOptions = {}
): void {
    const host: CommandHost<CommandSender> = {
        root: (name, description) => new Command([name], description),
        literal: (name) => CommandNode.literal(name),
        onRun: (run) =>
            onCommand((sender) => {
                run(sender);
                return 1;
            }),
        reply: (sender, line, tone) => sender.sendMessage(text(line, tone)),
        fail: (message) => {
            // The host's error type for a command that failed. The runtime takes a thrown value as the `err` of the result.
            throw { tag: 'command-failed', val: text(message, 'error') };
        }
    };

    const registered = new Set<string>();
    for (const { name, permission, node } of buildCommands<CommandSender, T>(host, tree, handlers)) {
        if (!registered.has(permission)) {
            registered.add(permission);
            ctx.registerPermission({
                node: permission,
                description: `Use the /${name} command`,
                default: options.defaultPermission ?? { tag: 'op', val: 'three' },
                children: []
            });
        }
        ctx.registerCommand(node as Command, permission);
    }
}
