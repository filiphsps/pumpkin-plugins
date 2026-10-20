import { CallbackGuard } from './expansion.ts';
import {
    decodeResult,
    type ExpansionRegistration,
    encodeRequest,
    InputError,
    LIMITS,
    type Line,
    PIE_PROVIDER,
    type PlaceholderValue,
    type ProviderInfo,
    type RegisteredExpansion,
    type RegisteredPlaceholder,
    type Request,
    type ResolvedLine,
    type ResultFor,
    UnavailableError,
    validateLine,
} from './protocol.ts';

/** Synchronous byte transport; inject plugin-kit ipcSend in a guest. */
export type SendMessage = (recipient: string, message: Uint8Array) => Uint8Array;
/** Shared guard and optional provider address for a coordinated client/router pair. */
export interface ClientOptions {
    readonly guard?: CallbackGuard;
    readonly provider?: string;
}
/** Validated protocol 0 consumer with no host imports or implicit cache. */
export class PieClient {
    readonly guard: CallbackGuard;
    private readonly send: SendMessage;
    private readonly provider: string;
    /** Inject the transport and share a callback guard with any expansion router. */
    constructor(send: SendMessage, options: ClientOptions = {}) {
        this.send = send;
        this.guard = options.guard ?? new CallbackGuard();
        this.provider = options.provider ?? PIE_PROVIDER;
    }
    /** Negotiate protocol 0; unsupported versions throw IncompatibleError. */
    ping(): ProviderInfo {
        return this.call({ op: 'ping' });
    }
    /** Resolve a line, even when it contains no tokens. Viewer is the subject's name. */
    resolve(text: string, viewer?: string, argument?: string): ResolvedLine {
        return this.call({ op: 'set_placeholders', text, viewer, argument });
    }
    /** Resolve exactly one bounded batch; discard mismatched output counts. */
    resolveBatch(requests: readonly Line[]): readonly ResolvedLine[] {
        return this.call({ op: 'set_placeholders_batch', requests });
    }
    /** Resolve valid inputs in bounded batches, returning nothing partial on failure. */
    resolveMany(lines: readonly Line[]): readonly ResolvedLine[] {
        this.guard.assertOutside();
        if (!Array.isArray(lines)) throw new InputError('Invalid line array');
        for (const line of lines) validateLine(line);
        // Snapshot caller data before transport callbacks can mutate it.
        const inputs = lines.map((line) => ({ text: line.text, viewer: line.viewer }));
        const batches: Line[][] = [];
        let batch: Line[] = [];
        const emptyBytes = encodeRequest({ op: 'set_placeholders_batch', requests: [] }).length;
        let bytes = emptyBytes;
        for (const line of inputs) {
            const size = encodeRequest({ op: 'set_placeholders_batch', requests: [line] }).length - emptyBytes;
            const extra = size + (batch.length ? 1 : 0);
            if (batch.length === LIMITS.batch || bytes + extra > LIMITS.message) {
                batches.push(batch);
                batch = [];
                bytes = emptyBytes;
            }
            batch.push(line);
            bytes += size + (batch.length > 1 ? 1 : 0);
        }
        if (batch.length) batches.push(batch);
        return batches.flatMap((chunk) => [...this.resolveBatch(chunk)]);
    }
    /** Look up one identifier, including placeholders requiring an argument. */
    getValue(id: string, viewer?: string, argument?: string): PlaceholderValue {
        return this.call({ op: 'get_placeholder_value', id, viewer, argument });
    }
    /** List built-in and contributed advertised placeholders. */
    list(): readonly RegisteredPlaceholder[] {
        return this.call({ op: 'get_registered_placeholders' });
    }
    /** Register or replace a namespace; returns applied TTL rather than requested TTL. */
    registerExpansion(registration: ExpansionRegistration): RegisteredExpansion {
        return this.call({ op: 'register_expansion', ...registration });
    }
    /** Drop ALL namespaces owned by the calling plugin, not just this client. */
    unregisterExpansions(): readonly string[] {
        return this.call({ op: 'unregister_expansion' });
    }
    private call<R extends Request>(request: R): ResultFor<R> {
        this.guard.assertOutside();
        const input = encodeRequest(request);
        let bytes: Uint8Array;
        try {
            bytes = this.send(this.provider, input);
        } catch {
            throw new UnavailableError('PumpkinPIE transport failed');
        }
        return decodeResult(bytes, request);
    }
}
