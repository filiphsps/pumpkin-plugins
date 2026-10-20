import { strToU8 } from 'fflate';
import {
    decodeCallback,
    type ExpansionRequest,
    encodeCallbackReply,
    InputError,
    normalizeName,
    normalizeNamespace,
    PIE_PROVIDER,
    ReentryError,
} from './protocol.ts';

/** A synchronous, local resolver. Undefined declines; empty text is a known value. */
export type ExpansionHandler = (context: ExpansionRequest) => string | undefined;
/** Shared by every PIE client and router owned by one plugin. */
export class CallbackGuard {
    private active = false;
    /** Refuse PIE operations while the provider waits for a callback. */
    assertOutside(): void {
        if (this.active) throw new ReentryError('PIE calls inside expansion callbacks are prohibited');
    }
    /** Run one synchronous resolver, restoring the guard even on exceptions. */
    run<T>(handler: () => T): T {
        this.assertOutside();
        this.active = true;
        try {
            return handler();
        } finally {
            this.active = false;
        }
    }
}
/** Dispatches authenticated provider callbacks to locally owned handlers. */
export class ExpansionRouter {
    private readonly handlers = new Map<string, Map<string, ExpansionHandler>>();
    readonly guard: CallbackGuard;
    readonly provider: string;
    /** The guard must also be passed to this plugin's clients. */
    constructor(guard: CallbackGuard, provider = PIE_PROVIDER) {
        this.guard = guard;
        this.provider = provider;
    }
    /** Claim local callback ownership and snapshot normalized handlers. */
    register(namespace: string, handlers: Readonly<Record<string, ExpansionHandler>>): readonly string[] {
        this.guard.assertOutside();
        const key = normalizeNamespace(namespace);
        const entries = new Map<string, ExpansionHandler>();
        for (const [name, handler] of Object.entries(handlers)) {
            if (typeof handler !== 'function') throw new InputError('Expansion handler must be synchronous');
            const normalized = normalizeName(name);
            if (entries.has(normalized)) throw new InputError('Duplicate normalized placeholder name');
            entries.set(normalized, handler);
        }
        this.handlers.set(key, entries);
        return [...entries.keys()];
    }
    /** Drop local ownership; provider unregistration is separately plugin-wide. */
    remove(namespace: string): void {
        this.guard.assertOutside();
        this.handlers.delete(normalizeNamespace(namespace));
    }
    /** Process actual host sender and bytes; errors never expose handler secrets. */
    handle(sender: string, bytes: Uint8Array): Uint8Array {
        try {
            if (sender !== this.provider) throw new InputError('Unexpected callback sender');
            const request = decodeCallback(bytes);
            const handler = this.handlers.get(request.namespace)?.get(request.name);
            return encodeCallbackReply(handler ? this.guard.run(() => handler(request)) : undefined);
        } catch {
            return strToU8('{"ok":false,"error":"Expansion callback refused"}');
        }
    }
}
