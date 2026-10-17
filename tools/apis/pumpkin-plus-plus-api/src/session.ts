import { PumpkinPlusPlusClient, type SendMessage, TransportError } from './client.ts';
import {
    type BridgeRejection,
    type CancelResult,
    type ChunkTarget,
    encodeRequest,
    IncompatibleError,
    InputError,
    type JobState,
    PROTOCOL_VERSION,
    type ProviderInfo,
    type ReleaseResult,
} from './protocol.ts';

/** Fixed upper bounds for compatibility caching and demand-driven exponential retry. */
export const SESSION_TIMING = Object.freeze({ cacheMs: 30000, initialRetryMs: 1000, maxRetryMs: 30000 });
/** Native installation instructions, independent of unrelated component releases. */
export const INSTALLATION_URL =
    'https://github.com/filiphsps/pumpkin-plugins/tree/master/native/pumpkin-plus-plus#readme';
/** Warning ownership shared by all sessions in one consuming plugin load. */
export class WarningScope {
    private warned = false;
    /** Reports installation guidance once, consuming ownership even if a logger throws. */
    report(kind: 'missing' | 'incompatible', warn: (message: string) => void): void {
        if (this.warned) return;
        this.warned = true;
        try {
            warn(`Pumpkin++ is ${kind}; install a compatible native build. See ${INSTALLATION_URL}`);
        } catch {
            /* Logging cannot change the typed provider result. */
        }
    }
}
const loadWarnings = new WarningScope();
/** Transport/provider failure, separate from queue saturation and job status. */
export interface ProviderFailure {
    readonly kind: 'missing' | 'incompatible' | 'temporarily_unreachable';
    /** Distinguishes reachability probing from failure during the requested operation. */
    readonly phase: 'probe' | 'operation';
    readonly status: 'provider_error';
}
/** Last observed provider/caller state; construction starts unknown without sending IPC. */
export type ProviderState =
    | { readonly kind: 'unknown' }
    | { readonly kind: 'available'; readonly info: ProviderInfo }
    | { readonly kind: ProviderFailure['kind'] };
/** A successful control observation or an actionable provider/bridge error. */
export type CallResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: ProviderFailure | BridgeRejection };
/** Host-independent dependencies; now returns monotonic milliseconds. */
export interface SessionOptions {
    readonly now: () => number;
    readonly send: SendMessage;
    readonly warn: (message: string) => void;
    /** Omit for module-load ownership; otherwise share one scope for the entire plugin load. */
    readonly warnings?: WarningScope;
}
/** Demand-driven optional provider: no timers, startup probe, retained host handles or automatic replay. */
export class PumpkinPlusPlusSession {
    private readonly client: PumpkinPlusPlusClient;
    private current: ProviderState = { kind: 'unknown' };
    private nextProbe = -Infinity;
    private backoff: number = SESSION_TIMING.initialRetryMs;
    private lastNow = -Infinity;
    /** Creates a session without calling any injected dependency. */
    constructor(private readonly options: SessionOptions) {
        this.client = new PumpkinPlusPlusClient(options.send);
    }
    /** Reads the last observation without probing or claiming current installation state. */
    get state(): ProviderState {
        return this.current;
    }
    /** Probes only when cache/backoff permits; repeated status checks remain bounded. */
    availability(): ProviderState {
        this.ensure(this.now());
        return this.state;
    }
    /** Admits one chunk job; every successful value carries its operation handle. */
    submit(target: ChunkTarget): CallResult<JobState> {
        const snapshot = { ...target, v: PROTOCOL_VERSION, op: 'submit' } as const;
        encodeRequest(snapshot);
        return this.call(() => this.client.submit(snapshot));
    }
    /** Observes a caller-owned operation during a later event or tick. */
    poll(operationId: string): CallResult<JobState> {
        encodeRequest({ v: PROTOCOL_VERSION, op: 'poll', operationId });
        return this.call(() => this.client.poll(operationId));
    }
    /** Cancels pending work; terminal completion can win the race. */
    cancel(operationId: string): CallResult<CancelResult> {
        encodeRequest({ v: PROTOCOL_VERSION, op: 'cancel', operationId });
        return this.call(() => this.client.cancel(operationId));
    }
    /** Explicitly relinquishes a finite lease; retry a lost reply during the native terminal-retention window. */
    release(leaseId: string): CallResult<ReleaseResult> {
        encodeRequest({ v: PROTOCOL_VERSION, op: 'release', leaseId });
        return this.call(() => this.client.release(leaseId));
    }
    private ensure(now: number): ProviderFailure | BridgeRejection | undefined {
        if (now < this.nextProbe) {
            if (this.current.kind === 'available') return;
            return {
                status: 'provider_error',
                kind: this.current.kind === 'unknown' ? 'temporarily_unreachable' : this.current.kind,
                phase: 'probe',
            };
        }
        try {
            const info = this.client.probe();
            if ('code' in info) return this.rejected(info, now, 'probe');
            this.current = { kind: 'available', info };
            this.nextProbe = now + SESSION_TIMING.cacheMs;
            this.backoff = SESSION_TIMING.initialRetryMs;
        } catch (error) {
            return this.failed(error, now, 'probe');
        }
    }
    private call<T>(invoke: () => T | BridgeRejection): CallResult<T> {
        const now = this.now();
        const failure = this.ensure(now);
        if (failure) return { ok: false, error: failure };
        try {
            const result = invoke();
            if (typeof result === 'object' && result !== null && 'code' in result)
                return { ok: false, error: this.rejected(result as BridgeRejection, now, 'operation') };
            return { ok: true, value: result as T };
        } catch (error) {
            if (error instanceof InputError) throw error;
            return { ok: false, error: this.failed(error, now, 'operation') };
        }
    }
    private rejected(error: BridgeRejection, now: number, phase: ProviderFailure['phase']): BridgeRejection {
        if (error.code === 'incompatible') {
            this.failed(new IncompatibleError(), now, phase);
        } else if (this.current.kind !== 'available') {
            this.current = { kind: 'temporarily_unreachable' };
            this.retry(now);
        }
        return error;
    }
    private failed(error: unknown, now: number, phase: ProviderFailure['phase']): ProviderFailure {
        const kind =
            error instanceof IncompatibleError
                ? 'incompatible'
                : error instanceof TransportError
                  ? error.kind
                  : 'temporarily_unreachable';
        this.current = { kind };
        this.retry(now);
        if (kind === 'missing' || kind === 'incompatible')
            (this.options.warnings ?? loadWarnings).report(kind, this.options.warn);
        return { status: 'provider_error', kind, phase };
    }
    private retry(now: number): void {
        this.nextProbe = now + this.backoff;
        this.backoff = Math.min(this.backoff * 2, SESSION_TIMING.maxRetryMs);
    }
    private now(): number {
        const value = this.options.now();
        if (
            !Number.isFinite(value) ||
            value < 0 ||
            value < this.lastNow ||
            value > Number.MAX_SAFE_INTEGER - SESSION_TIMING.maxRetryMs
        )
            throw new InputError('Clock must return finite monotonic milliseconds');
        this.lastNow = value;
        return value;
    }
}
