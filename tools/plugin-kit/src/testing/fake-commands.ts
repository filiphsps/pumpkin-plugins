import type { CommandHost, CommandNodeLike } from '../commands.ts';

/** A node of a fake command tree, with what was attached to it. */
export class FakeNode implements CommandNodeLike {
    readonly children: FakeNode[] = [];
    handlerId: number | undefined;

    /** Creates a node for the word `name`. */
    constructor(readonly name: string) {}

    // biome-ignore lint/suspicious/noThenProperty: mirrors the host's command classes, which have `then`.
    then(child: CommandNodeLike): void {
        this.children.push(child as FakeNode);
    }

    executeWithHandlerId(id: number): void {
        this.handlerId = id;
    }
}

/** A sender that records the lines sent to it, and which of them were shown as errors. */
export interface FakeSender {
    lines: string[];
    errors: string[];
}

/** What `FakeCommandHost.fail` throws: the message a failed command would show. */
export class FakeCommandFailure extends Error {}

/** A `CommandHost` that builds `FakeNode`s and runs handlers by id, so tests can use a command tree without a server. */
export class FakeCommandHost implements CommandHost<FakeSender> {
    private readonly handlers = new Map<number, (sender: FakeSender) => void>();

    root(name: string): FakeNode {
        return new FakeNode(name);
    }

    literal(name: string): FakeNode {
        return new FakeNode(name);
    }

    onRun(run: (sender: FakeSender) => void): number {
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

    /** Runs the command at the end of `path` (the words after `/`) and returns what it sent back. */
    run(root: FakeNode, path: string[]): string[] {
        return this.runAs(root, path).lines;
    }

    /**
     * Runs the command at the end of `path` and returns the sender, to see which lines were errors.
     * @throws {FakeCommandFailure} When the command failed.
     */
    runAs(root: FakeNode, path: string[]): FakeSender {
        let node: FakeNode | undefined = path[0] === root.name ? root : undefined;
        for (const word of path.slice(1)) node = node?.children.find((child) => child.name === word);
        const handler = node?.handlerId === undefined ? undefined : this.handlers.get(node.handlerId);
        if (!handler) throw new Error(`/${path.join(' ')} is not runnable`);
        const sender: FakeSender = { lines: [], errors: [] };
        handler(sender);
        return sender;
    }

    /** The usages of every runnable node under `root`, such as `/demo list`. */
    usages(root: FakeNode, prefix: string[] = [root.name]): string[] {
        const own = root.handlerId === undefined ? [] : [`/${prefix.join(' ')}`];
        return [...own, ...root.children.flatMap((child) => this.usages(child, [...prefix, child.name]))];
    }
}
