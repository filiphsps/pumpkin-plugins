/**
 * Hands out ids for callbacks the host calls back by number. The API package's own base class
 * does this too, but with ids and maps we can't reach, so this plugin keeps its own range.
 */
export class HandlerRegistry<F> {
    private readonly handlers = new Map<number, F>();
    private nextId: number;

    /** Creates a registry whose ids start at `firstId`. */
    constructor(firstId: number) {
        if (!Number.isInteger(firstId) || firstId < 0 || firstId > 0xffff_ffff) {
            throw new RangeError('Handler ids must be unsigned 32-bit integers');
        }
        this.nextId = firstId;
    }

    /**
     * Registers a handler.
     * @param handler - The callback.
     * @returns Its id.
     */
    add(handler: F): number {
        if (this.nextId > 0xffff_ffff) throw new RangeError('Handler ids exhausted');
        const id = this.nextId++;
        this.handlers.set(id, handler);
        return id;
    }

    /**
     * Looks a handler up.
     * @param id - An id from `add`.
     * @returns The handler, or undefined when the id isn't ours.
     */
    get(id: number): F | undefined {
        return this.handlers.get(id);
    }

    /** Removes and returns a handler by id. */
    take(id: number): F | undefined {
        const handler = this.handlers.get(id);
        this.handlers.delete(id);
        return handler;
    }
}
