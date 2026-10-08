import type { CommandArgumentSpec, CommandArgumentValue } from '@pumpkin-plugins/docs';
import type { CommandHost, CommandNodeLike, CommandSuggestionHandler, CommandSuggestionRequest } from '../commands.ts';

/** A node of a fake command tree, with what was attached to it. */
export class FakeNode implements CommandNodeLike {
    readonly children: FakeNode[] = [];
    handlerId: number | undefined;
    suggestionHandlerId: number | undefined;
    private consumed = false;

    /** Creates a node for the word `name`. */
    constructor(
        readonly name: string,
        readonly argument?: CommandArgumentSpec
    ) {}

    // biome-ignore lint/suspicious/noThenProperty: mirrors the host's command classes, which have `then`.
    then(child: CommandNodeLike): void {
        this.assertAvailable();
        const fakeChild = child as FakeNode;
        fakeChild.consume();
        this.children.push(fakeChild);
    }

    executeWithHandlerId(id: number): void {
        this.assertAvailable();
        this.handlerId = id;
    }

    suggestWithHandlerId(id: number): void {
        this.assertAvailable();
        this.suggestionHandlerId = id;
    }

    private consume(): void {
        this.assertAvailable();
        this.consumed = true;
    }

    private assertAvailable(): void {
        if (this.consumed) throw new Error('Command node has already been consumed by a parent.');
    }
}

/** A sender that records the lines sent to it, and which of them were shown as errors. */
export interface FakeSender {
    lines: string[];
    errors: string[];
    asPlayer(): undefined;
}

/** What `FakeCommandHost.fail` throws: the message a failed command would show. */
export class FakeCommandFailure extends Error {}

/** A `CommandHost` that builds `FakeNode`s and runs handlers by id, so tests can use a command tree without a server. */
export class FakeCommandHost implements CommandHost<FakeSender> {
    private readonly handlers = new Map<
        number,
        (sender: FakeSender, args: Readonly<Record<string, CommandArgumentValue>>) => void
    >();
    private readonly suggestionHandlers = new Map<number, CommandSuggestionHandler<FakeSender>>();

    get suggestionHandlerCount(): number {
        return this.suggestionHandlers.size;
    }

    root(name: string): FakeNode {
        return new FakeNode(name);
    }

    literal(name: string): FakeNode {
        return new FakeNode(name);
    }

    argument(spec: CommandArgumentSpec): FakeNode {
        return new FakeNode(`<${spec.name}>`, spec);
    }

    onSuggest(handler: CommandSuggestionHandler<FakeSender>): number {
        const id = 100_000 + this.suggestionHandlers.size;
        this.suggestionHandlers.set(id, handler);
        return id;
    }

    onRun(
        run: (sender: FakeSender, args: Readonly<Record<string, CommandArgumentValue>>) => void,
        _arguments: readonly CommandArgumentSpec[]
    ): number {
        const id = this.handlers.size + 1;
        this.handlers.set(id, run);
        return id;
    }

    reply(sender: FakeSender, line: string, tone?: 'error'): void {
        sender.lines.push(line);
        if (tone === 'error') sender.errors.push(line);
    }

    fail(text: string): never {
        throw new FakeCommandFailure(text);
    }

    hasPermission(_sender: FakeSender, _permission: string): boolean {
        return true;
    }

    /** Resolves suggestions for an argument node through its registered callback. */
    suggest(root: FakeNode, path: string[], request: CommandSuggestionRequest): string[] {
        let node: FakeNode | undefined = path[0] === root.name ? root : undefined;
        for (const word of path.slice(1)) node = node?.children.find((child) => child.name === word);
        const id = node?.suggestionHandlerId;
        const handler = id === undefined ? undefined : this.suggestionHandlers.get(id);
        if (handler === undefined) throw new Error(`/${path.join(' ')} has no suggestion handler`);
        return [...handler({ lines: [], errors: [], asPlayer: () => undefined }, request)];
    }

    /** Runs the command at the end of `path` (the words after `/`) and returns what it sent back. */
    run(
        root: FakeNode,
        path: string[],
        args: Readonly<Record<string, CommandArgumentValue>> = {},
        sender?: FakeSender
    ): string[] {
        return this.runAs(root, path, args, sender).lines;
    }

    /**
     * Runs the command at the end of `path` and returns the sender, to see which lines were errors.
     * @throws {FakeCommandFailure} When the command failed.
     */
    runAs(
        root: FakeNode,
        path: string[],
        args: Readonly<Record<string, CommandArgumentValue>> = {},
        suppliedSender?: FakeSender
    ): FakeSender {
        let node: FakeNode | undefined = path[0] === root.name ? root : undefined;
        for (const word of path.slice(1)) node = node?.children.find((child) => child.name === word);
        const handler = node?.handlerId === undefined ? undefined : this.handlers.get(node.handlerId);
        if (!handler) throw new Error(`/${path.join(' ')} is not runnable`);
        const sender = suppliedSender ?? { lines: [], errors: [], asPlayer: () => undefined };
        handler(sender, args);
        return sender;
    }

    /** The usages of every runnable node under `root`, such as `/demo list`. */
    usages(root: FakeNode, prefix: string[] = [root.name]): string[] {
        const own = root.handlerId === undefined ? [] : [`/${prefix.join(' ')}`];
        return [...own, ...root.children.flatMap((child) => this.usages(child, [...prefix, child.name]))];
    }
}
