import { MAX_REQUEST_BYTES, parseRequest } from './http.ts';
import { type PackLookup, planResponse, type ResponseBody } from './response.ts';

export type { PackFile, PackLookup } from './response.ts';

/** A connection as the session sees it. Everything is non-blocking. */
export interface Transport {
    /** Up to `max` bytes, `null` when nothing has arrived yet, `'closed'` when the peer is gone. */
    read(max: number): Uint8Array | null | 'closed';
    /** How many bytes can be written right now. */
    writable(): number;
    /** Queues bytes for sending. At most `writable()` bytes at a time. */
    write(bytes: Uint8Array): void;
    /** Called every tick once everything is written. Returns true once the connection is closed. */
    finish(): boolean;
    /** Closes immediately, dropping unsent data. */
    abort(): void;
}

/** Limits that keep one connection from hurting the server. */
export interface SessionOptions {
    /** The current time in milliseconds. */
    now: () => number;
    /** A connection that makes no progress for this long is dropped. */
    idleTimeoutMs: number;
    /** Most bytes sent per tick, so one big download can't stall the server tick. */
    writeBudget: number;
    /** Most bytes read from the pack file at once. */
    chunkSize: number;
}

type State = 'request' | 'send' | 'finish' | 'closed';

/** One HTTP/1.1 exchange: read a request, send one response, close. Driven by `tick()`. */
export class HttpSession {
    private state: State = 'request';
    private received: Uint8Array = new Uint8Array(0);
    private head: Uint8Array = new Uint8Array(0);
    private headSent = 0;
    private body: ResponseBody | undefined;
    private lastProgress: number;

    /** Starts waiting for a request on the transport. */
    constructor(
        private readonly transport: Transport,
        private readonly lookup: PackLookup,
        private readonly options: SessionOptions
    ) {
        this.lastProgress = options.now();
    }

    /**
     * Moves the exchange forward: reads what has arrived, sends what fits, closes when done.
     * @returns True while the session needs more ticks.
     */
    tick(): boolean {
        if (this.is('closed')) return false;
        if (this.options.now() - this.lastProgress > this.options.idleTimeoutMs) return this.abort();
        try {
            if (this.is('request') && !this.readRequest()) return !this.is('closed');
            if (this.is('send')) this.send();
            if (this.is('finish') && this.transport.finish()) this.state = 'closed';
        } catch {
            return this.abort();
        }
        return !this.is('closed');
    }

    /**
     * Closes the connection and the pack file without finishing the response.
     * @returns False, so callers can `return session.abort()` from a tick.
     */
    abort(): false {
        this.body?.file.close();
        this.body = undefined;
        if (!this.is('closed')) this.transport.abort();
        this.state = 'closed';
        return false;
    }

    /** Reads the state through a method so TypeScript doesn't narrow it across the mutations below. */
    private is(state: State): boolean {
        return this.state === state;
    }

    /** Returns true once a request has been read and a response chosen. */
    private readRequest(): boolean {
        const chunk = this.transport.read(MAX_REQUEST_BYTES - this.received.length);
        if (chunk === 'closed') {
            this.abort();
            return false;
        }
        if (chunk === null || chunk.length === 0) return false;

        this.lastProgress = this.options.now();
        const joined = new Uint8Array(this.received.length + chunk.length);
        joined.set(this.received);
        joined.set(chunk, this.received.length);
        this.received = joined;

        const request = parseRequest(this.received);
        if (request === 'incomplete') return false;

        const plan = planResponse(request === 'bad' ? undefined : request, this.lookup);
        this.head = plan.head;
        this.body = plan.body;
        this.state = 'send';
        return true;
    }

    private send(): void {
        let budget = this.options.writeBudget;
        while (budget > 0) {
            const space = this.transport.writable();
            if (space <= 0) return;

            if (this.headSent < this.head.length) {
                const n = Math.min(space, budget, this.head.length - this.headSent);
                this.transport.write(this.head.subarray(this.headSent, this.headSent + n));
                this.headSent += n;
                budget -= n;
            } else if (this.body && this.body.remaining > 0) {
                const n = Math.min(space, budget, this.options.chunkSize, this.body.remaining);
                const data = this.body.file.read(this.body.offset, n);
                if (data.length === 0) throw new Error('pack file ended early');
                this.transport.write(data);
                this.body.offset += data.length;
                this.body.remaining -= data.length;
                budget -= data.length;
            } else {
                break;
            }
            this.lastProgress = this.options.now();
        }

        const bodyDone = !this.body || this.body.remaining === 0;
        if (this.headSent === this.head.length && bodyDone) {
            this.body?.file.close();
            this.body = undefined;
            this.state = 'finish';
        }
    }
}
