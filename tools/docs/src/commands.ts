import type { CommandInfo } from './info.ts';

/** A permission's default access level. */
export type CommandPermissionDefault =
    | { readonly tag: 'deny' }
    | { readonly tag: 'allow' }
    | { readonly tag: 'op'; readonly val: 'zero' | 'one' | 'two' | 'three' | 'four' };

/** Operators of level three and the console may use commands by default. */
export const DEFAULT_COMMAND_PERMISSION: CommandPermissionDefault = { tag: 'op', val: 'three' };

/** A subcommand: what it does, and optionally more subcommands below it. */
export interface SubcommandSpec<Node extends string = string> {
    /** Shown in the README and in the game's command help. */
    description: string;
    /** Permission node for this path. Omit it to inherit the nearest parent's node. */
    permission?: Node;
    /** Who may use this path by default. Omit it to inherit the nearest parent's default. */
    defaultPermission?: CommandPermissionDefault;
    /** Subcommands below this one. A command with subcommands only groups them. */
    subcommands?: SubcommandTree<Node>;
}

/** Subcommands by name. */
export type SubcommandTree<Node extends string = string> = { readonly [name: string]: SubcommandSpec<Node> };

/** A command the plugin registers: the first word typed after `/`. */
export interface CommandSpec<Node extends string = string> extends SubcommandSpec<Node> {
    /** Permission node for this command or group. Pumpkin requires it to start with the plugin's name. */
    permission: Node;
}

/** The plugin's commands by name. */
export type CommandTree<Node extends string = string> = { readonly [name: string]: CommandSpec<Node> };

/**
 * The paths of the commands that can be run, as typed: `baddon list`. A command with subcommands
 * only groups them, so only the leaves are paths.
 */
export type CommandPath<T extends SubcommandTree> = {
    [K in keyof T & string]: T[K] extends { subcommands: infer S extends SubcommandTree }
        ? `${K} ${CommandPath<S>}`
        : K;
}[keyof T & string];

/** One line a command sends back: plain text, or an error shown in red. */
export type CommandLine = string | { readonly text: string; readonly tone: 'error' };

/**
 * A line to show as an error, in red, without failing the command.
 * @param text - What to say.
 */
export const errorLine = (text: string): CommandLine => ({ text, tone: 'error' });

/** Thrown by a handler to make its command fail: the sender sees the message as an error. */
export class CommandFailed extends Error {}

/** What runs a command. It returns the lines to send back to whoever ran it, or throws `CommandFailed`. */
export type CommandHandler<Sender = unknown> = (sender: Sender) => readonly CommandLine[];

/** One handler for every runnable command of a tree. A missing or misspelled path is a compile error. */
export type CommandHandlers<T extends CommandTree, Sender = unknown> = {
    readonly [P in CommandPath<T>]: CommandHandler<Sender>;
};

/** A runnable command, flattened out of a tree. */
export interface FlatCommand {
    /** The words typed after `/`. */
    path: string[];
    /** For example `/baddon list`. */
    usage: string;
    description: string;
    /** The permission of the command it belongs to. */
    permission: string;
    /** Who may run the command by default. */
    defaultPermission: CommandPermissionDefault;
}

/** A command permission to register, with its inheritance links. */
export interface CommandPermissionInfo {
    node: string;
    description: string;
    defaultPermission: CommandPermissionDefault;
    children: { node: string; value: boolean }[];
}

/**
 * Declares a plugin's commands. The same object registers them with Pumpkin and documents them in
 * the README, so the two can't drift apart.
 * @param _pluginName - The plugin's name. It only constrains the permission nodes to start with it.
 * @param tree - The commands.
 * @returns The tree, with its literal types kept.
 */
export function defineCommands<const Name extends string, const T extends CommandTree<`${Name}:${string}`>>(
    _pluginName: Name,
    tree: T
): T {
    return tree;
}

/**
 * Lists the runnable commands of a tree, in the order they were declared.
 * @param tree - The commands.
 */
export function flattenCommands(tree: CommandTree): FlatCommand[] {
    const out: FlatCommand[] = [];
    const walk = (
        subs: SubcommandTree,
        path: string[],
        permission: string,
        defaultPermission: CommandPermissionDefault
    ): void => {
        for (const [name, spec] of Object.entries(subs)) {
            const here = [...path, name];
            const herePermission = spec.permission ?? permission;
            const hereDefault = spec.defaultPermission ?? defaultPermission;
            if (spec.subcommands && Object.keys(spec.subcommands).length > 0) {
                walk(spec.subcommands, here, herePermission, hereDefault);
            } else {
                out.push({
                    path: here,
                    usage: `/${here.join(' ')}`,
                    description: spec.description,
                    permission: herePermission,
                    defaultPermission: hereDefault
                });
            }
        }
    };
    for (const [name, spec] of Object.entries(tree)) {
        if (spec.subcommands && Object.keys(spec.subcommands).length > 0)
            walk(spec.subcommands, [name], spec.permission, spec.defaultPermission ?? DEFAULT_COMMAND_PERMISSION);
        else
            out.push({
                path: [name],
                usage: `/${name}`,
                description: spec.description,
                permission: spec.permission,
                defaultPermission: spec.defaultPermission ?? DEFAULT_COMMAND_PERMISSION
            });
    }
    return out;
}

/**
 * Lists every distinct permission in a command tree and connects each parent to its direct children.
 * @param tree - The commands, from `defineCommands`.
 */
export function commandPermissionInfos(tree: CommandTree): CommandPermissionInfo[] {
    const permissions = new Map<string, CommandPermissionInfo>();

    const add = (
        node: string,
        path: string[],
        defaultPermission: CommandPermissionDefault,
        isGroup: boolean
    ): CommandPermissionInfo => {
        const existing = permissions.get(node);
        if (existing) {
            if (JSON.stringify(existing.defaultPermission) !== JSON.stringify(defaultPermission)) {
                throw new Error(`conflicting defaults for command permission ${node}`);
            }
            return existing;
        }
        const info: CommandPermissionInfo = {
            node,
            description: `Use the /${path.join(' ')} command${isGroup ? 's' : ''}`,
            defaultPermission,
            children: []
        };
        permissions.set(node, info);
        return info;
    };

    const walk = (
        specs: SubcommandTree,
        path: string[],
        parentNode: string,
        inheritedDefault: CommandPermissionDefault
    ): void => {
        for (const [name, spec] of Object.entries(specs)) {
            const here = [...path, name];
            const node = spec.permission ?? parentNode;
            const defaultPermission = spec.defaultPermission ?? inheritedDefault;
            const parent = add(parentNode, path, inheritedDefault, true);
            const hasSubcommands = spec.subcommands && Object.keys(spec.subcommands).length > 0;
            add(node, here, defaultPermission, Boolean(hasSubcommands));
            if (node !== parentNode && !parent.children.some((child) => child.node === node)) {
                parent.children.push({ node, value: true });
            }
            if (hasSubcommands && spec.subcommands) {
                walk(spec.subcommands, here, node, defaultPermission);
            }
        }
    };

    for (const [name, spec] of Object.entries(tree)) {
        const rootDefault = spec.defaultPermission ?? DEFAULT_COMMAND_PERMISSION;
        const hasSubcommands = spec.subcommands && Object.keys(spec.subcommands).length > 0;
        add(spec.permission, [name], rootDefault, Boolean(hasSubcommands));
        if (hasSubcommands && spec.subcommands) {
            walk(spec.subcommands, [name], spec.permission, rootDefault);
        }
    }

    return [...permissions.values()];
}

/**
 * The commands as the README lists them, for `info.commands`.
 * @param tree - The commands.
 */
export function commandInfos<Node extends string>(tree: CommandTree<Node>): CommandInfo<Node>[] {
    return flattenCommands(tree).map(({ usage, description, permission, defaultPermission }) => ({
        usage,
        description,
        permission: permission as Node,
        defaultPermission
    }));
}
