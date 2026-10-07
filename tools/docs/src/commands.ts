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
    /** Required arguments that follow this leaf command. */
    arguments?: readonly CommandArgumentSpec[];
    /** Subcommands below this one. A command with subcommands only groups them. */
    subcommands?: SubcommandTree<Node>;
}

/** An integer or string argument supported by the shared command helpers. */
export type CommandArgumentSpec =
    | { readonly name: string; readonly type: 'integer'; readonly min?: number; readonly max?: number }
    | { readonly name: string; readonly type: 'string'; readonly mode: 'single-word' | 'quotable' | 'greedy' };

/** Values inferred for a command's declared arguments. */
export type CommandArgumentValues<Arguments extends readonly CommandArgumentSpec[]> = {
    readonly [Argument in Arguments[number] as Argument['name']]: Argument extends { readonly type: 'integer' }
        ? number
        : string;
};

/** Subcommands by name. */
export type SubcommandTree<Node extends string = string> = { readonly [name: string]: SubcommandSpec<Node> };

/** A command the plugin registers: the first word typed after `/`. */
export interface CommandSpec<Node extends string = string> extends SubcommandSpec<Node> {
    /** Permission node for this command or group. Pumpkin requires it to start with the plugin's name. */
    permission: Node;
}

/** The plugin's commands by name. */
export type CommandTree<Node extends string = string> = { readonly [name: string]: CommandSpec<Node> };

type AppendPath<Prefix extends string, Name extends string> = Prefix extends '' ? Name : `${Prefix} ${Name}`;
type ArgumentUsage<Arguments extends readonly CommandArgumentSpec[]> = Arguments extends readonly [
    infer First extends CommandArgumentSpec,
    ...infer Rest extends readonly CommandArgumentSpec[]
]
    ? ` <${First['name']}>${ArgumentUsage<Rest>}`
    : '';
type HandlerEntries<T extends SubcommandTree, Sender, Prefix extends string = ''> = {
    [K in keyof T & string]: T[K] extends { readonly subcommands: infer Nested extends SubcommandTree }
        ? HandlerEntries<Nested, Sender, AppendPath<Prefix, K>>
        : T[K] extends { readonly arguments: infer Arguments extends readonly CommandArgumentSpec[] }
          ? {
                [Path in `${AppendPath<Prefix, K>}${ArgumentUsage<Arguments>}`]: (
                    sender: Sender,
                    args: CommandArgumentValues<Arguments>
                ) => readonly CommandLine[];
            }
          : { [Path in AppendPath<Prefix, K>]: (sender: Sender) => readonly CommandLine[] };
}[keyof T & string];
type UnionToIntersection<Values> = (Values extends unknown ? (value: Values) => void : never) extends (
    value: infer Intersection
) => void
    ? Intersection
    : never;

/** The runnable paths of a command tree, including argument placeholders. */
export type CommandPath<T extends SubcommandTree> = keyof UnionToIntersection<HandlerEntries<T, never>> & string;

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
export type CommandHandlers<T extends CommandTree, Sender = unknown> = UnionToIntersection<HandlerEntries<T, Sender>>;

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
    /** Required argument nodes that follow this command. */
    arguments: readonly CommandArgumentSpec[];
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
                    usage: usageFor(here, spec.arguments),
                    description: spec.description,
                    permission: herePermission,
                    defaultPermission: hereDefault,
                    arguments: spec.arguments ?? []
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
                usage: usageFor([name], spec.arguments),
                description: spec.description,
                permission: spec.permission,
                defaultPermission: spec.defaultPermission ?? DEFAULT_COMMAND_PERMISSION,
                arguments: spec.arguments ?? []
            });
    }
    return out;
}

function usageFor(path: string[], arguments_: readonly CommandArgumentSpec[] | undefined): string {
    validateArguments(arguments_ ?? []);
    const argumentsUsage = arguments_?.map(({ name }) => ` <${name}>`).join('') ?? '';
    return `/${path.join(' ')}${argumentsUsage}`;
}

function validateArguments(arguments_: readonly CommandArgumentSpec[]): void {
    const names = new Set<string>();
    for (const [index, argument] of arguments_.entries()) {
        if (!/^[a-zA-Z0-9_]+$/.test(argument.name)) throw new Error(`Invalid command argument name: ${argument.name}`);
        if (names.has(argument.name)) throw new Error(`Duplicate command argument name: ${argument.name}`);
        names.add(argument.name);

        if (argument.type === 'integer') {
            const minimum = -2_147_483_648;
            const maximum = 2_147_483_647;
            for (const bound of [argument.min, argument.max]) {
                if (bound !== undefined && (!Number.isInteger(bound) || bound < minimum || bound > maximum)) {
                    throw new Error(`Integer bounds for ${argument.name} must fit a signed 32-bit value.`);
                }
            }
            if (argument.min !== undefined && argument.max !== undefined && argument.min > argument.max) {
                throw new Error(`Minimum bound exceeds maximum bound for ${argument.name}.`);
            }
        } else if (argument.mode === 'greedy' && index !== arguments_.length - 1) {
            throw new Error(`Greedy string argument ${argument.name} must be the final argument.`);
        }
    }
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
