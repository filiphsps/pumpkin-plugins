import type { CommandInfo } from './info.ts';

/** A subcommand: what it does, and optionally more subcommands below it. */
export interface SubcommandSpec {
    /** Shown in the README and in the game's command help. */
    description: string;
    /** Subcommands below this one. A command with subcommands only groups them. */
    subcommands?: SubcommandTree;
}

/** Subcommands by name. */
export type SubcommandTree = { readonly [name: string]: SubcommandSpec };

/** A command the plugin registers: the first word typed after `/`. */
export interface CommandSpec<Node extends string = string> extends SubcommandSpec {
    /** Permission node needed to run it. Pumpkin requires it to start with the plugin's name. */
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
export type CommandHandler = () => readonly CommandLine[];

/** One handler for every runnable command of a tree. A missing or misspelled path is a compile error. */
export type CommandHandlers<T extends CommandTree> = { readonly [P in CommandPath<T>]: CommandHandler };

/** A runnable command, flattened out of a tree. */
export interface FlatCommand {
    /** The words typed after `/`. */
    path: string[];
    /** For example `/baddon list`. */
    usage: string;
    description: string;
    /** The permission of the command it belongs to. */
    permission: string;
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
    const walk = (subs: SubcommandTree, path: string[], permission: string): void => {
        for (const [name, spec] of Object.entries(subs)) {
            const here = [...path, name];
            if (spec.subcommands && Object.keys(spec.subcommands).length > 0) {
                walk(spec.subcommands, here, permission);
            } else {
                out.push({ path: here, usage: `/${here.join(' ')}`, description: spec.description, permission });
            }
        }
    };
    for (const [name, spec] of Object.entries(tree)) {
        if (spec.subcommands && Object.keys(spec.subcommands).length > 0)
            walk(spec.subcommands, [name], spec.permission);
        else out.push({ path: [name], usage: `/${name}`, description: spec.description, permission: spec.permission });
    }
    return out;
}

/**
 * The commands as the README lists them, for `info.commands`.
 * @param tree - The commands.
 */
export function commandInfos<Node extends string>(tree: CommandTree<Node>): CommandInfo<Node>[] {
    return flattenCommands(tree).map(({ usage, description, permission }) => ({
        usage,
        description,
        permission: permission as Node
    }));
}
