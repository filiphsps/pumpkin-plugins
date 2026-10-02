import { strFromU8 } from 'fflate';
import type { PackFile, Transport } from '../src/web/session.ts';

/** A scripted connection: feed it request chunks, limit how much it accepts, read what was written. */
export class FakeTransport implements Transport {
    /** Chunks `read` hands out, one per call. `'closed'` makes the peer disconnect. */
    inbound: Array<Uint8Array | 'closed'> = [];
    /** Bytes accepted per tick. Set before each `tick()`. */
    space = Number.POSITIVE_INFINITY;
    written: number[] = [];
    aborted = false;
    failWrites = false;
    /** How many `finish()` calls it takes before the connection counts as closed. */
    finishAfter = 1;
    private finishCalls = 0;

    read(max: number): Uint8Array | null | 'closed' {
        const next = this.inbound.shift();
        if (next === undefined) return null;
        if (next === 'closed') return next;
        if (next.length > max) {
            this.inbound.unshift(next.subarray(max));
            return next.subarray(0, max);
        }
        return next;
    }

    writable(): number {
        return this.space;
    }

    write(bytes: Uint8Array): void {
        if (this.failWrites) throw new Error('connection reset');
        this.space -= bytes.length;
        this.written.push(...bytes);
    }

    finish(): boolean {
        return ++this.finishCalls >= this.finishAfter;
    }

    abort(): void {
        this.aborted = true;
    }

    /** Everything written so far, split into status, headers and body. */
    response(): { status: number; headers: Record<string, string>; body: Uint8Array } {
        const bytes = Uint8Array.from(this.written);
        let end = -1;
        for (let i = 0; i + 3 < bytes.length; i++) {
            if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
                end = i;
                break;
            }
        }
        if (end === -1) throw new Error('no complete response head was written');
        const [statusLine, ...lines] = strFromU8(bytes.subarray(0, end)).split('\r\n');
        const headers = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]));
        return { status: Number(statusLine.split(' ')[1]), headers, body: bytes.subarray(end + 4) };
    }
}

/** An in-memory pack file that counts how often it was closed. */
export class FakeFile implements PackFile {
    closed = 0;
    reads: number[] = [];
    constructor(private readonly data: Uint8Array) {}

    get size(): number {
        return this.data.length;
    }

    read(offset: number, length: number): Uint8Array {
        this.reads.push(length);
        return this.data.subarray(offset, offset + length);
    }

    close(): void {
        this.closed++;
    }
}
