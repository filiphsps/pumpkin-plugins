import { Command, CommandNode, type CommandSender } from 'pumpkin:plugin/command@0.1.0';
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type { PermissionDefault } from 'pumpkin:plugin/permission@0.1.0';
import { TextComponent } from 'pumpkin:plugin/text@0.1.0';
import { type CommandHandlers, type CommandTree, commandPermissionInfos } from '@pumpkin-plugins/docs';
import { buildCommands, type CommandHost } from './commands.ts';
import { onCommand } from './host.ts';

const COMMAND_ACCESS_PERMISSION_SUFFIX = ':command._access';

function text(line: string, tone?: 'error'): TextComponent {
    const component = TextComponent.text(line);
    if (tone === 'error') component.colorNamed('red');
    return component;
}

/**
 * Registers a plugin's commands, permissions and per-subcommand permission checks.
 * @param ctx - The plugin context.
 * @param tree - The commands, from `defineCommands`.
 * @param handlers - What runs each command: the lines to send back, or a thrown `CommandFailed`.
 */
export function registerCommands<T extends CommandTree>(
    ctx: Context,
    tree: T,
    handlers: CommandHandlers<T, CommandSender>
): void {
    const server = ctx.getServer();
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
        },
        hasPermission: (sender, permission) => sender.hasPermission(server, permission)
    };

    for (const permission of commandPermissionInfos(tree)) {
        ctx.registerPermission({
            node: permission.node,
            description: permission.description,
            default: permission.defaultPermission as PermissionDefault,
            children: permission.children
        });
    }

    const registered = new Set<string>();
    const registerAccessPermission = (permission: string): void => {
        if (registered.has(permission)) return;
        registered.add(permission);
        ctx.registerPermission({
            node: permission,
            description: 'Access registered plugin commands',
            default: { tag: 'allow' },
            children: []
        });
    };

    for (const { name, permission, node } of buildCommands<CommandSender, T>(host, tree, handlers)) {
        const spec = tree[name];
        const hasSubcommands = spec.subcommands && Object.keys(spec.subcommands).length > 0;
        const rootPermission = hasSubcommands
            ? permission.slice(0, permission.indexOf(':')) + COMMAND_ACCESS_PERMISSION_SUFFIX
            : permission;
        if (hasSubcommands) registerAccessPermission(rootPermission);
        ctx.registerCommand(node as Command, rootPermission);
    }
}
