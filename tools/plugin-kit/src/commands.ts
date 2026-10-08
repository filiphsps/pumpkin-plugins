import {
    type CommandArgumentSpec,
    type CommandArgumentValue,
    CommandFailed,
    type CommandHandlers,
    type CommandLine,
    type CommandPath,
    type CommandTree,
    flattenCommands,
    type SubcommandTree
} from '@pumpkin-plugins/docs';

/** A node of a command tree being built. The host's own command classes satisfy it. */
export interface CommandNodeLike {
    /** Adds a child node and transfers ownership of that child to this node. */
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
    /** Creates a typed argument below a node. */
    argument(spec: CommandArgumentSpec): CommandNodeLike;
    /** Registers what runs when a command is used, and returns its id. */
    onRun(
        run: (sender: Sender, args: Readonly<Record<string, CommandArgumentValue>>) => void,
        arguments_: readonly CommandArgumentSpec[]
    ): number;
    /** Sends a line back to whoever ran the command. An `error` line is shown in red. */
    reply(sender: Sender, line: string, tone?: 'error'): void;
    /** Makes the running command fail with a message, the way the server reports a failed command. Never returns. */
    fail(text: string): never;
    /** Checks whether a sender has a command permission. */
    hasPermission(sender: Sender, permission: string): boolean;
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
    handlers: CommandHandlers<T, Sender>
): BuiltCommand[] {
    const lookup = handlers as unknown as Record<
        string,
        ((sender: Sender, args: Readonly<Record<string, CommandArgumentValue>>) => readonly CommandLine[]) | undefined
    >;

    const handlerFor = (
        key: string
    ): ((sender: Sender, args: Readonly<Record<string, CommandArgumentValue>>) => readonly CommandLine[]) => {
        const handler = lookup[key];
        if (!Object.hasOwn(lookup, key) || typeof handler !== 'function') {
            throw new Error(`no handler for /${key}`);
        }
        return handler;
    };
    // Validate before allocating host nodes or callbacks, so a missing late handler leaves no partial tree.
    const flatCommands = flattenCommands(tree);
    for (const { path, arguments: arguments_ } of flatCommands) handlerFor(handlerPath(path, arguments_));
    validateArgumentVariantPrefixes(tree);

    const register = (
        node: CommandNodeLike,
        path: string[],
        permission: string,
        checkPermission: boolean,
        arguments_: readonly CommandArgumentSpec[]
    ): void => {
        const key = handlerPath(path, arguments_) as CommandPath<T>;
        const handler = handlerFor(key);
        const handlerId = host.onRun((sender, args) => {
            if (checkPermission && !host.hasPermission(sender, permission)) {
                host.fail('You do not have permission to use this command.');
            }
            let lines: readonly CommandLine[];
            try {
                lines = handler(sender, args);
            } catch (err) {
                if (err instanceof CommandFailed) host.fail(err.message);
                throw err;
            }
            for (const line of lines) {
                if (typeof line === 'string') host.reply(sender, line);
                else host.reply(sender, line.text, line.tone);
            }
        }, arguments_);
        node.executeWithHandlerId(handlerId);
    };

    const fill = (node: CommandNodeLike, subs: SubcommandTree, path: string[], permission: string): void => {
        for (const [name, spec] of Object.entries(subs)) {
            const child = host.literal(name);
            const here = [...path, name];
            const herePermission = spec.permission ?? permission;
            const nested = spec.subcommands && Object.keys(spec.subcommands).length > 0;
            if (nested && spec.subcommands) fill(child, spec.subcommands, here, herePermission);
            else if (spec.argumentVariants !== undefined) {
                register(child, here, herePermission, true, []);
                attachArgumentBranches(
                    child,
                    here,
                    herePermission,
                    true,
                    createArgumentBranches(spec.argumentVariants, here)
                );
            } else attach(child, here, herePermission, true, spec.arguments ?? []);
            node.then(child);
        }
    };

    const attachArgumentBranches = (
        node: CommandNodeLike,
        path: string[],
        permission: string,
        checkPermission: boolean,
        branches: readonly ArgumentBranch[],
        prefix: readonly CommandArgumentSpec[] = []
    ): void => {
        for (const branch of branches) {
            const child = host.argument(branch.spec);
            const arguments_ = [...prefix, branch.spec];
            if (branch.terminal) register(child, path, permission, checkPermission, arguments_);
            attachArgumentBranches(child, path, permission, checkPermission, [...branch.children.values()], arguments_);
            node.then(child);
        }
    };

    const attach = (
        node: CommandNodeLike,
        path: string[],
        permission: string,
        checkPermission: boolean,
        arguments_: readonly CommandArgumentSpec[] = []
    ): void => {
        if (arguments_.length === 0) {
            register(node, path, permission, checkPermission, arguments_);
            return;
        }

        const argumentNodes = arguments_.map((argument) => host.argument(argument));
        const lastNode = argumentNodes.at(-1);
        if (!lastNode) throw new Error(`command /${handlerPath(path, arguments_)} has no argument node`);
        register(lastNode, path, permission, checkPermission, arguments_);
        for (let index = argumentNodes.length - 2; index >= 0; index--) {
            argumentNodes[index]?.then(argumentNodes[index + 1] as CommandNodeLike);
        }
        node.then(argumentNodes[0] as CommandNodeLike);
    };

    return Object.entries(tree).map(([name, spec]) => {
        const node = host.root(name, spec.description);
        const nested = spec.subcommands && Object.keys(spec.subcommands).length > 0;
        if (nested && spec.subcommands) fill(node, spec.subcommands, [name], spec.permission);
        else if (spec.argumentVariants !== undefined) {
            register(node, [name], spec.permission, false, []);
            attachArgumentBranches(
                node,
                [name],
                spec.permission,
                false,
                createArgumentBranches(spec.argumentVariants, [name])
            );
        } else attach(node, [name], spec.permission, false, spec.arguments ?? []);
        return { name, description: spec.description, permission: spec.permission, node };
    });
}

interface ArgumentBranch {
    spec: CommandArgumentSpec;
    terminal: boolean;
    children: Map<string, ArgumentBranch>;
}

function validateArgumentVariantPrefixes(tree: CommandTree): void {
    const walk = (subs: SubcommandTree, path: string[]): void => {
        for (const [name, spec] of Object.entries(subs)) {
            const here = [...path, name];
            if (spec.subcommands && Object.keys(spec.subcommands).length > 0) walk(spec.subcommands, here);
            else if (spec.argumentVariants !== undefined) createArgumentBranches(spec.argumentVariants, here);
        }
    };
    walk(tree, []);
}

function createArgumentBranches(
    variants: readonly (readonly CommandArgumentSpec[])[],
    path: readonly string[]
): ArgumentBranch[] {
    const roots = new Map<string, ArgumentBranch>();
    for (const variant of variants) {
        let siblings = roots;
        let terminal: ArgumentBranch | undefined;
        for (const spec of variant) {
            terminal = siblings.get(spec.name);
            if (terminal && !sameArgument(terminal.spec, spec)) {
                throw new Error(`Conflicting argument definitions for <${spec.name}> on /${path.join(' ')}.`);
            }
            if (!terminal) {
                terminal = { spec, terminal: false, children: new Map() };
                siblings.set(spec.name, terminal);
            }
            siblings = terminal.children;
        }
        if (!terminal) throw new Error(`Command /${path.join(' ')} has an empty argument variant.`);
        if (terminal.terminal) throw new Error(`Duplicate argument variant for /${path.join(' ')}.`);
        terminal.terminal = true;
    }
    return [...roots.values()];
}

function sameArgument(left: CommandArgumentSpec, right: CommandArgumentSpec): boolean {
    if (left.name !== right.name || left.type !== right.type) return false;
    if (left.type === 'integer' && right.type === 'integer') {
        return left.min === right.min && left.max === right.max;
    }
    if (left.type === 'double' && right.type === 'double') {
        return left.min === right.min && left.max === right.max;
    }
    if (left.type === 'players' && right.type === 'players') return true;
    return left.type === 'string' && right.type === 'string' && left.mode === right.mode;
}

function handlerPath(path: readonly string[], arguments_: readonly CommandArgumentSpec[]): string {
    const literalPath = path.join(' ');
    const argumentPath = arguments_.map(({ name }) => `<${name}>`).join(' ');
    return argumentPath ? `${literalPath} ${argumentPath}` : literalPath;
}
