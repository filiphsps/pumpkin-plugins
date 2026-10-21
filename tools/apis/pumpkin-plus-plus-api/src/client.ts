import {
    type ChunkTarget,
    decodeReply,
    encodeRequest,
    PROTOCOL_VERSION,
    PROVIDER,
    type Request,
    type ResultFor,
} from './protocol.ts';

/** Synchronous bounded IPC; inject plugin-kit ipcSend rather than importing the host here. */
export type SendMessage = (recipient: string, message: Uint8Array) => Uint8Array;
/** Availability evidence supplied by a transport that can actually distinguish recipient absence. */
export class TransportError extends Error {
    /** Use missing only with positive evidence; generic Pumpkin IPC exceptions are unreachable. */
    constructor(readonly kind: 'missing' | 'temporarily_unreachable') {
        super(`Pumpkin++ transport: ${kind}`);
    }
}
/** Low-level validated control calls; use PumpkinPlusPlusSession for compatibility caching. */
export class PumpkinPlusPlusClient {
    /** Retains the injected transport without probing or importing ambient host services. */
    constructor(private readonly send: SendMessage) {}
    /** Probes the native provider protocol, identity and exact host build. */
    probe() {
        return this.call({ v: PROTOCOL_VERSION, op: 'probe' });
    }
    /** Returns promptly with an operation handle and observed state, never a waiting Promise. */
    submit(target: ChunkTarget) {
        return this.call({ ...target, v: PROTOCOL_VERSION, op: 'submit' });
    }
    /** Observes work from a later callback; a ready lease is not renewed by polling. */
    poll(operationId: string) {
        return this.call({ v: PROTOCOL_VERSION, op: 'poll', operationId });
    }
    /** Cancels pending work; if completion wins the race, returns its ready lease for release. */
    cancel(operationId: string) {
        return this.call({ v: PROTOCOL_VERSION, op: 'cancel', operationId });
    }
    /** Releases a caller-owned lease, including when the native release is already complete. */
    release(leaseId: string) {
        return this.call({ v: PROTOCOL_VERSION, op: 'release', leaseId });
    }
    private call<R extends Request>(request: R): ResultFor<R> {
        const input = encodeRequest(request);
        let bytes: Uint8Array;
        try {
            bytes = this.send(PROVIDER, input);
        } catch (error) {
            if (error instanceof TransportError) throw error;
            throw new TransportError('temporarily_unreachable');
        }
        return decodeReply(bytes, request);
    }
}
