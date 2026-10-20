import { MAX_REQUEST_BYTES, parseRequest } from './http.ts';
import { type PackLookup, planResponse, type ResponseBody } from './response.ts';

export type { PackFile, PackLookup } from './response.ts';

/** A connection as the session sees it. Everything is non-blocking. */
export interface Transport {
    /** Closes immediately, dropping unsent data. */
    abort(): void;
    /** Called every tick once everything is written. Returns true once the connection is closed. */
    finish(): boolean;
    /** Up to `max` bytes, `null` when nothing has arrived yet, `'closed'` when the peer is gone. */
    read(max: number): Uint8Array | null | 'closed';
    /** How many bytes can be written right now. */
    writable(): number;
    /** Queues bytes for sending. At most `writable()` bytes at a time. */
    write(bytes: Uint8Array): void;
}

/** Limits that keep one connection from hurting the server. */
export interface SessionOptions {
    /** Most bytes read from the pack file at once. */
    chunkSize: number;
    /** A connection that makes no progress for this long is dropped. */
    idleTimeoutMs: number;
    /**
     * Bytes that count as progress while sending. A client that reads less than this per
     * `idleTimeoutMs` is dropped, so slow readers can't hold a connection open forever.
     */
    minProgressBytes: number;
    /** The current time in milliseconds. */
    now: () => number;
    /** Most bytes sent per tick, so one big download can't stall the server tick. */
    writeBudget: number;
}

/** One server tick's remaining quota, shared by every active session. */
export interface TickQuota {
    /** HTTP bytes read or queued, including request and response heads. File reads are charged on write. */
    bytes: number;
    /** Host I/O calls remaining; resource disposal and deadline checks are always serviced. */
    operations: number;
}

type State = 'request' | 'send' | 'finish' | 'closed';

/** One HTTP/1.1 exchange: read a request, send one response, close. Driven by `tick()`. */
export class HttpSession {
    private state: State = 'request';
    private received: Uint8Array = new Uint8Array(0);
    private head: Uint8Array = new Uint8Array(0);
    private headSent = 0;
    /** Bytes sent since the idle timer last restarted. */
    private sentSinceProgress = 0;
    private body: ResponseBody | undefined;
    private lastProgress: number;
    private readonly headDeadline: number;

    /** Starts waiting for a request on the transport. */
    constructor(
        private readonly transport: Transport,
        private readonly lookup: PackLookup,
        private readonly options: SessionOptions,
    ) {
        this.lastProgress = options.now();
        this.headDeadline = this.lastProgress + options.idleTimeoutMs;
    }

    /**
     * Moves the exchange forward: reads what has arrived, sends what fits, closes when done.
     * @returns True while the session needs more ticks.
     */
    tick(quota: TickQuota = { bytes: this.options.writeBudget, operations: 64 }): boolean {
        if (this.is('closed')) return false;
        const now = this.options.now();
        if (this.is('request') && now >= this.headDeadline) return this.abort();
        if (now - this.lastProgress > this.options.idleTimeoutMs) return this.abort();
        try {
            if (this.is('request') && !this.readRequest(quota)) return !this.is('closed');
            if (this.is('send')) this.send(quota);
            if (this.is('finish') && quota.operations >= 2) {
                // finish may flush once, or check capacity and shut down the send direction.
                quota.operations -= 2;
                if (this.transport.finish()) this.state = 'closed';
            }
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
    private readRequest(quota: TickQuota): boolean {
        if (quota.operations < 3 || quota.bytes <= 0) return false;
        // Reserve the read and up to two file-open/stat calls when the head completes.
        quota.operations -= 3;
        const max = Math.min(MAX_REQUEST_BYTES - this.received.length, quota.bytes);
        quota.bytes -= max;
        const chunk = this.transport.read(max);
        quota.bytes += max - (chunk === null || chunk === 'closed' ? 0 : chunk.length);
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

    private send(quota: TickQuota): void {
        let budget = Math.min(this.options.writeBudget, quota.bytes);
        while (budget > 0) {
            const headPending = this.headSent < this.head.length;
            if (!headPending && (!this.body || this.body.remaining === 0)) break;
            // Capacity + write for heads, with one additional file read for bodies.
            if (quota.operations < (headPending ? 2 : 3)) break;
            quota.operations--;
            const space = this.transport.writable();
            if (space <= 0) break;

            if (headPending) {
                const n = Math.min(space, budget, this.head.length - this.headSent);
                quota.operations--;
                quota.bytes -= n;
                this.transport.write(this.head.subarray(this.headSent, this.headSent + n));
                this.headSent += n;
                this.sentSinceProgress += n;
                budget -= n;
            } else if (this.body && this.body.remaining > 0) {
                const n = Math.min(space, budget, this.options.chunkSize, this.body.remaining);
                quota.operations--;
                const data = this.body.file.read(this.body.offset, n);
                if (data.length === 0) throw new Error('pack file ended early');
                quota.operations--;
                quota.bytes -= data.length;
                this.transport.write(data);
                this.body.offset += data.length;
                this.body.remaining -= data.length;
                this.sentSinceProgress += data.length;
                budget -= data.length;
            } else {
                break;
            }
        }

        const bodyDone = !this.body || this.body.remaining === 0;
        const done = this.headSent === this.head.length && bodyDone;
        if (done || this.sentSinceProgress >= this.options.minProgressBytes) {
            this.lastProgress = this.options.now();
            this.sentSinceProgress = 0;
        }
        if (done) {
            this.body?.file.close();
            this.body = undefined;
            this.state = 'finish';
        }
    }
}
