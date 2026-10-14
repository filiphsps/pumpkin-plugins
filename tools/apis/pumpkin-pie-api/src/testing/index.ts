import { strToU8 } from 'fflate';
import type { SendMessage } from '../client.ts';
import { decodeJson } from '../protocol.ts';

/** Scripted byte boundary, without pretending to implement the provider's placeholder engine. */
export class FakeTransport {
    readonly messages: { recipient: string; request: unknown; bytes: Uint8Array }[] = [];
    private readonly replies: (Uint8Array | Error)[] = [];
    /** Queue a literal JSON fixture, raw malformed bytes, or a transport failure. */
    enqueue(reply: unknown): void {
        this.replies.push(
            reply instanceof Error || reply instanceof Uint8Array ? reply : strToU8(JSON.stringify(reply)),
        );
    }
    /** Injectable transport; fails if no fixture remains. */
    readonly send: SendMessage = (recipient, bytes) => {
        this.messages.push({ recipient, request: decodeJson(bytes), bytes: bytes.slice() });
        const reply = this.replies.shift();
        if (reply instanceof Error) throw reply;
        if (!reply) throw new Error('No queued IPC reply');
        return reply.slice();
    };
}
/** Monotonic test clock, measured in milliseconds, with no real sleeps. */
export class FakeClock {
    private time = 0;
    readonly now = (): number => this.time;
    /** Advance virtual time, refusing backwards or nonfinite movement. */
    advance(ms: number): void {
        if (!Number.isFinite(ms) || ms < 0) throw new Error('Invalid clock advance');
        this.time += ms;
    }
}
