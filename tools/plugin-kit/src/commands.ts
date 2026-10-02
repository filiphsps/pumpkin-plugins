import {
    CommandFailed,
    type CommandHandlers,
    type CommandLine,
    type CommandPath,
    type CommandTree,
    type SubcommandTree
} from '@pumpkin-plugins/docs';

/** A node of a command tree being built. The host's own command classes satisfy it. */
export interface CommandNodeLike {
    /** Adds a child node. */
    then(child: CommandNodeLike): unknown;
    /** Makes the node runnable: the host calls the handler registered under this id. */
    executeWithHandlerId(id: number): unknown;
}

/** What building commands needs from the host. `registerCommands` implements it with Pumpkin's command classes. */
export interface CommandHost<Sender> {
    /** Creates the root of a command: the word typed after `/`. */
    root(name: string, description: string): CommandNodeLike;
    /** Creates a fixed word below a node. */
    literal(name: string): CommandNodeLike;
    /** Registers what runs when a command is used, and returns its id. */
    onRun(run: (sender: Sender) => void): number;
    /** Sends a line back to whoever ran the command. An `error` line is shown in red. */
    reply(sender: Sender, line: string, tone?: 'error'): void;
    /** Makes the running command fail with a message, the way the server reports a failed command. Never returns. */
    fail(text: string): never;
}

/** A command ready to be registered with the server. */
export interface BuiltCommand {
    name: string;
    description: string;
    /** The permission node needed to run it. */
    permission: string;
    /** Its root node. */
    node: CommandNodeLike;
}

/**
 * Builds the command nodes of a tree, with the handlers attached. The tree is the same object the
 * README is generated from, so what is registered is what is documented.
 * @param host - Creates the nodes.
 * @param tree - The commands, from `defineCommands`.
 * @param handlers - What runs each command.
 * @returns One entry per command.
 * @throws {Error} When a runnable command has no handler, which the types already prevent.
 */
export function buildCommands<Sender, T extends CommandTree>(
    host: CommandHost<Sender>,
    tree: T,
    handlers: CommandHandlers<T>
): BuiltCommand[] {
    const lookup = handlers as unknown as Record<string, (() => readonly CommandLine[]) | undefined>;

    const fill = (node: CommandNodeLike, subs: SubcommandTree, path: string[]): void => {
        for (const [name, spec] of Object.entries(subs)) {
            const child = host.literal(name);
            const here = [...path, name];
            const nested = spec.subcommands && Object.keys(spec.subcommands).length > 0;
            if (nested && spec.subcommands) fill(child, spec.subcommands, here);
            else attach(child, here);
            node.then(child);
        }
    };

    const attach = (node: CommandNodeLike, path: string[]): void => {
        const key = path.join(' ') as CommandPath<T>;
        const handler = lookup[key];
        if (!handler) throw new Error(`no handler for /${key}`);
        node.executeWithHandlerId(
            host.onRun((sender) => {
                let lines: readonly CommandLine[];
                try {
                    lines = handler();
                } catch (err) {
                    if (err instanceof CommandFailed) host.fail(err.message);
                    throw err;
                }
                for (const line of lines) {
                    if (typeof line === 'string') host.reply(sender, line);
                    else host.reply(sender, line.text, line.tone);
                }
            })
        );
    };

    return Object.entries(tree).map(([name, spec]) => {
        const node = host.root(name, spec.description);
        const nested = spec.subcommands && Object.keys(spec.subcommands).length > 0;
        if (nested && spec.subcommands) fill(node, spec.subcommands, [name]);
        else attach(node, [name]);
        return { name, description: spec.description, permission: spec.permission, node };
    });
}
