import { PieClient, type SendMessage } from './client.ts';
import { CallbackGuard, type ExpansionHandler, ExpansionRouter } from './expansion.ts';
import {
    type Cache,
    type ExpansionRegistration,
    encodeRequest,
    IncompatibleError,
    InputError,
    normalizeNamespace,
    PIE_PROVIDER,
    type ProviderInfo,
    UnavailableError,
    validateCache,
} from './protocol.ts';
import { SESSION_TIMING } from './session-timing.ts';

/** Availability state, without cached placeholder values or error payloads. */
export type SessionState =
    | { readonly kind: 'unavailable' }
    | { readonly kind: 'incompatible' }
    | { readonly kind: 'ready'; readonly info: ProviderInfo };
/** Host-independent scheduling and transition reporting. Clock returns monotonic milliseconds. */
export interface SessionOptions {
    readonly now: () => number;
    readonly onTransition?: (state: SessionState) => void;
    readonly pingIntervalMs?: number;
    readonly provider?: string;
    readonly send: SendMessage;
}
/** Plugin-wide expansion ownership, negotiation and bounded recovery. Call tick explicitly. */
export class PieSession {
    readonly client: PieClient;
    readonly router: ExpansionRouter;
    private current: SessionState = { kind: 'unavailable' };
    private readonly desired = new Map<string, ExpansionRegistration>();
    private readonly applied = new Map<string, Cache>();
    private readonly guard = new CallbackGuard();
    private nextAttempt = -Infinity;
    private backoff: number = SESSION_TIMING.initialRetryMs;
    private stopped = false;
    private reachable = false;
    private readonly interval: number;
    private readonly options: SessionOptions;
    /** One session per calling plugin; no global timers or watcher per line. */
    constructor(options: SessionOptions) {
        this.options = options;
        this.interval = options.pingIntervalMs ?? SESSION_TIMING.defaultPingMs;
        if (
            !Number.isFinite(this.interval) ||
            this.interval < SESSION_TIMING.minPingMs ||
            this.interval > SESSION_TIMING.maxPingMs
        )
            throw new InputError(`Ping interval must be ${SESSION_TIMING.minPingMs}–${SESSION_TIMING.maxPingMs} ms`);
        const provider = options.provider ?? PIE_PROVIDER;
        this.client = new PieClient(options.send, { guard: this.guard, provider });
        this.router = new ExpansionRouter(this.guard, provider);
    }
    /** Current negotiation state; only ready consumers should resolve placeholders. */
    get state(): SessionState {
        return this.current;
    }
    /** Cache policy from the last successful registration, absent while unavailable. */
    appliedCache(namespace: string): Cache | undefined {
        return this.applied.get(normalizeNamespace(namespace));
    }
    /** Record desired handlers; tick applies them after negotiation and every recovery. */
    registerExpansion(
        namespace: string,
        handlers: Readonly<Record<string, ExpansionHandler>>,
        cache: Cache = { kind: 'never' },
    ): void {
        this.guard.assertOutside();
        if (this.stopped) throw new InputError('Session is stopped');
        const key = normalizeNamespace(namespace);
        const policy = validateCache(cache);
        encodeRequest({ op: 'register_expansion', namespace: key, placeholders: Object.keys(handlers), cache: policy });
        const names = this.router.register(key, handlers);
        this.desired.set(key, { namespace: key, placeholders: names, cache: policy });
        this.nextAttempt = -Infinity;
    }
    /** Ping and renew registrations when due, with bounded retry backoff. */
    tick(): void {
        this.guard.assertOutside();
        if (this.stopped) return;
        const now = this.options.now();
        if (!Number.isFinite(now)) throw new InputError('Invalid session clock');
        if (now < this.nextAttempt) return;
        let state: SessionState;
        try {
            const info = this.client.ping();
            this.reachable = true;
            const applied = new Map<string, Cache>();
            // Renew periodically: identical-version provider restarts have no epoch on the wire.
            for (const [key, registration] of this.desired)
                applied.set(key, this.client.registerExpansion(registration).cache);
            this.applied.clear();
            for (const [key, policy] of applied) this.applied.set(key, policy);
            this.backoff = SESSION_TIMING.initialRetryMs;
            this.nextAttempt = now + this.interval;
            state = { kind: 'ready', info };
        } catch (error) {
            if (error instanceof UnavailableError || error instanceof IncompatibleError) this.reachable = false;
            this.applied.clear();
            this.nextAttempt = now + this.backoff;
            this.backoff = Math.min(this.backoff * 2, SESSION_TIMING.maxRetryMs);
            state = { kind: error instanceof IncompatibleError ? 'incompatible' : 'unavailable' };
        }
        this.transition(state);
    }
    /** Stop permanently; set unregister to false when the host is shutting down. */
    stop(options: { readonly unregister?: boolean } = {}): void {
        this.guard.assertOutside();
        if (this.stopped) return;
        this.stopped = true;
        try {
            if (options.unregister !== false && this.reachable) this.client.unregisterExpansions();
        } catch {
            /* Reachability can change between the last ping and stop. */
        } finally {
            for (const namespace of this.desired.keys()) this.router.remove(namespace);
            this.desired.clear();
            this.applied.clear();
            this.transition({ kind: 'unavailable' });
        }
    }
    private transition(state: SessionState): void {
        const changed = state.kind !== this.current.kind;
        this.current = state;
        if (changed) this.options.onTransition?.(state);
    }
}
