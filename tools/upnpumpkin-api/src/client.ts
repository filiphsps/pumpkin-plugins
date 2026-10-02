import {
    decodeReply,
    encodeRequest,
    type NetworkInfo,
    type PortRequest,
    type PortStatus,
    type Reply,
    type Request,
    UPNPUMPKIN_PLUGIN
} from './protocol.ts';

/**
 * Sends one IPC message and returns the answer.
 * @throws {Error} When the recipient isn't loaded or can't answer.
 */
export type SendMessage = (recipient: string, message: Uint8Array) => Uint8Array;

/** UPnPumpkin isn't installed, isn't loaded yet, or didn't answer. */
export class UnavailableError extends Error {}

/** UPnPumpkin answered, but with an error (for example a request it didn't understand). */
export class RejectedError extends Error {}

/** Talks to UPnPumpkin from another plugin. */
export class PortMapClient {
    /** Creates a client. `send` is the plugin's IPC call. */
    constructor(private readonly send: SendMessage) {}

    /**
     * Asks for a port to be made reachable, or checks on it. Repeating a request changes nothing, so
     * call it again to find out how it is going.
     * @throws {UnavailableError} When UPnPumpkin can't be reached.
     * @throws {RejectedError} When UPnPumpkin refuses the request.
     */
    ensure(request: PortRequest): PortStatus {
        return this.statusOf(this.call({ op: 'ensure', ...request }));
    }

    /**
     * The state of a port asked for earlier.
     * @throws {UnavailableError} When UPnPumpkin can't be reached.
     */
    status(key: string): PortStatus {
        return this.statusOf(this.call({ op: 'status', key }));
    }

    /**
     * Stops keeping a port open.
     * @throws {UnavailableError} When UPnPumpkin can't be reached.
     */
    release(key: string): void {
        this.call({ op: 'release', key });
    }

    /**
     * What UPnPumpkin knows about the network.
     * @throws {UnavailableError} When UPnPumpkin can't be reached.
     */
    info(): NetworkInfo {
        return this.call({ op: 'info' }).info ?? {};
    }

    private call(request: Request): Extract<Reply, { ok: true }> {
        let bytes: Uint8Array;
        try {
            bytes = this.send(UPNPUMPKIN_PLUGIN, encodeRequest(request));
        } catch (err) {
            throw new UnavailableError(err instanceof Error ? err.message : String(err));
        }
        const reply = decodeReply(bytes);
        if (!reply)
            throw new UnavailableError(
                'UPnPumpkin sent an answer this plugin does not understand (is it a different version?)'
            );
        if (!reply.ok) throw new RejectedError(reply.error);
        return reply;
    }

    private statusOf(reply: Extract<Reply, { ok: true }>): PortStatus {
        return reply.status ?? { kind: 'unknown' };
    }
}
