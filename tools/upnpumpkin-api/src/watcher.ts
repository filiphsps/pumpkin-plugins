import { type PortMapClient, RejectedError } from './client.ts';
import type { PortRequest, PortStatus } from './protocol.ts';

/** What a watcher reports: the port's status, or that UPnPumpkin can't be reached. */
export type WatchedState = PortStatus | { kind: 'unavailable'; reason: string };

/** Milliseconds between checks, by state. Waiting for an answer is checked often, a settled port rarely. */
const CHECK_MS = { pending: 1000, open: 30_000, other: 15_000 };

/**
 * Keeps asking UPnPumpkin about one port and tells you when the answer changes. It copes with
 * UPnPumpkin loading after your plugin, being reloaded, or not being installed at all.
 */
export class MappingWatcher {
    private current: WatchedState | undefined;
    private nextCheckAt = 0;
    private running = false;

    /** Creates a stopped watcher. */
    constructor(
        private readonly client: PortMapClient,
        private readonly request: PortRequest,
        private readonly onChange: (state: WatchedState) => void,
        private readonly now: () => number
    ) {}

    /** The latest state, or undefined before the first answer. */
    get state(): WatchedState | undefined {
        return this.current;
    }

    /** Starts asking. The first check happens at once. */
    start(): void {
        this.running = true;
        this.nextCheckAt = 0;
        this.tick();
    }

    /** Checks again when it is time. Call once per game tick. */
    tick(): void {
        if (!this.running || this.now() < this.nextCheckAt) return;
        const state = this.check();
        const kind = state.kind === 'pending' || state.kind === 'open' ? state.kind : 'other';
        this.nextCheckAt = this.now() + CHECK_MS[kind];
        if (JSON.stringify(state) !== JSON.stringify(this.current)) {
            this.current = state;
            this.onChange(state);
        }
    }

    /** Stops asking and optionally tells UPnPumpkin to close the port. Safe to call twice. */
    stop(options: { releasePort?: boolean } = {}): void {
        if (!this.running) return;
        this.running = false;
        this.current = undefined;
        if (options.releasePort === false) return;
        try {
            this.client.release(this.request.key);
        } catch {
            // UPnPumpkin is gone, and with it the mapping.
        }
    }

    private check(): WatchedState {
        try {
            return this.client.ensure(this.request);
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            return err instanceof RejectedError ? { kind: 'failed', reason } : { kind: 'unavailable', reason };
        }
    }
}

/**
 * The `http://` base URL players reach a port at, once it is open.
 * @returns The URL, or undefined when the port isn't open.
 */
export function openUrl(state: WatchedState | undefined): string | undefined {
    return state?.kind === 'open' ? `http://${state.address}:${state.port}` : undefined;
}
