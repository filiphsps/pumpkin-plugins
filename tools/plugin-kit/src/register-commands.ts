import { type Arg, Command, CommandNode, type CommandSender, type ConsumedArgs } from 'pumpkin:plugin/command@0.1.0';
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type { PermissionDefault } from 'pumpkin:plugin/permission@0.1.0';
import { TextComponent } from 'pumpkin:plugin/text@0.1.0';
import * as uuid from 'pumpkin:plugin/uuid@0.1.0';
import {
    type CommandArgumentSpec,
    type CommandArgumentValue,
    CommandFailed,
    type CommandHandlers,
    type CommandTree,
    commandPermissionInfos
} from '@pumpkin-plugins/docs';
import { buildCommands, type CommandHost } from './commands.ts';
import { onCommand } from './host.ts';
import { disposeWasiResource } from './wasi-resource.ts';

const COMMAND_ACCESS_PERMISSION_SUFFIX = ':command._access';

function text(line: string, tone?: 'error'): TextComponent {
    const component = TextComponent.fromLegacyString(line);
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
        argument: (spec) => CommandNode.argument(spec.name, argumentType(spec)),
        onRun: (run, arguments_) =>
            onCommand((sender, consumed) => {
                try {
                    run(sender, decodeArguments(arguments_, consumed));
                    return 1;
                } catch (err) {
                    if (err instanceof CommandFailed) {
                        throw { tag: 'command-failed', val: text(err.message, 'error') };
                    }
                    throw err;
                } finally {
                    disposeWasiResource(consumed);
                }
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

function argumentType(spec: CommandArgumentSpec) {
    if (spec.type === 'integer') {
        return {
            tag: 'integer' as const,
            val: [spec.min, spec.max] as [number | undefined, number | undefined]
        };
    }
    if (spec.type === 'double') {
        return {
            tag: 'double' as const,
            val: [spec.min, spec.max] as [number | undefined, number | undefined]
        };
    }
    if (spec.type === 'players') return { tag: 'players' as const };
    if (spec.type === 'item') return { tag: 'item' as const };
    return { tag: 'string' as const, val: spec.mode };
}

function decodeArguments(
    specs: readonly CommandArgumentSpec[],
    consumed: ConsumedArgs
): Readonly<Record<string, CommandArgumentValue>> {
    const values: Record<string, CommandArgumentValue> = {};
    for (const spec of specs) {
        let argument: Arg;
        try {
            argument = consumed.getValue(spec.name);
        } catch {
            throw new CommandFailed(`Argument ${spec.name} is missing or invalid.`);
        }

        if (spec.type === 'integer') {
            if (argument.tag !== 'num' || argument.val.tag !== 'ok' || argument.val.val.tag !== 'int32') {
                throw new CommandFailed(`Argument ${spec.name} must be an integer.`);
            }
            const value = argument.val.val.val;
            if (
                !Number.isSafeInteger(value) ||
                (spec.min !== undefined && value < spec.min) ||
                (spec.max !== undefined && value > spec.max)
            ) {
                throw new CommandFailed(`Argument ${spec.name} is outside its allowed range.`);
            }
            values[spec.name] = value;
            continue;
        }

        if (spec.type === 'double') {
            if (argument.tag !== 'num' || argument.val.tag !== 'ok' || argument.val.val.tag !== 'float64') {
                throw new CommandFailed(`Argument ${spec.name} must be a number.`);
            }
            const value = argument.val.val.val;
            if (
                !Number.isFinite(value) ||
                (spec.min !== undefined && value < spec.min) ||
                (spec.max !== undefined && value > spec.max)
            ) {
                throw new CommandFailed(`Argument ${spec.name} is outside its allowed range.`);
            }
            values[spec.name] = value;
            continue;
        }

        if (spec.type === 'players') {
            if (argument.tag !== 'players') throw new CommandFailed(`Argument ${spec.name} must select players.`);
            try {
                values[spec.name] = argument.val.map((player) => ({
                    id: uuid.toString(player.getId()),
                    name: player.getName()
                }));
            } finally {
                for (const player of argument.val) disposeWasiResource(player);
            }
            continue;
        }

        if (spec.type === 'item') {
            // Some Pumpkin hosts expose an item argument through a different Arg variant; callers can recover its raw token.
            values[spec.name] = argument.tag === 'item' || argument.tag === 'simple' ? argument.val : '';
            continue;
        }

        if (argument.tag !== 'simple') throw new CommandFailed(`Argument ${spec.name} must be ${spec.mode} text.`);
        values[spec.name] = argument.val;
    }
    return values;
}
