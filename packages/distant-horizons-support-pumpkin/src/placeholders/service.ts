import { ipcSend } from '@pumpkin-plugins/plugin-kit/ipc';
import {
    type ExpansionHandler,
    PieSession,
    type SendMessage,
    type SessionState,
} from '@pumpkin-plugins/pumpkin-pie-api';
import type { LodCache } from '../lod/cache.ts';
import type { Sessions } from '../session.ts';
import { dhsPlaceholderDefinitions } from './definitions.ts';

/** Dependencies for the optional expansion and its clock and transport test seams. */
export interface DistantHorizonsPlaceholderServiceOptions {
    readonly cache: Pick<LodCache, 'stats'>;
    /** Monotonic milliseconds for provider negotiation and recovery. */
    readonly now: () => number;
    readonly onTransition?: (state: SessionState) => void;
    readonly send?: SendMessage;
    readonly sessions: Pick<Sessions, 'hasClient' | 'placeholderSnapshot'>;
}

/** Owns the optional `dhs` expansion and its recoverable PumpkinPIE session. */
export class DistantHorizonsPlaceholderService {
    private readonly session: PieSession;

    constructor(private readonly options: DistantHorizonsPlaceholderServiceOptions) {
        this.session = new PieSession({
            send: options.send ?? ipcSend,
            now: options.now,
            onTransition: options.onTransition,
        });
        const handlers: Record<string, ExpansionHandler> = {};
        for (const { name } of dhsPlaceholderDefinitions) {
            handlers[name] = ({ name: requestedName, viewer, argument }) =>
                this.resolve(requestedName, viewer, argument);
        }
        this.session.registerExpansion('dhs', handlers, { kind: 'never' });
    }

    /** Negotiates the provider and reapplies the namespace after automatic recovery. */
    tick(): void {
        this.session.tick();
    }

    /** Routes only the actual host sender and payload through the shared expansion router. */
    handleIpcMessage(sender: string, message: Uint8Array): Uint8Array {
        return this.session.router.handle(sender, message);
    }

    /** Stops the local session without sending IPC while Pumpkin is unloading the plugin. */
    stop(): void {
        this.session.stop({ unregister: false });
    }

    private resolve(name: string, viewer: string | undefined, argument: string | undefined): string | undefined {
        if (argument !== undefined) return undefined;
        if (name === 'client_connected')
            return viewer === undefined ? undefined : String(this.options.sessions.hasClient(viewer));

        const snapshot = this.options.sessions.placeholderSnapshot();
        switch (name) {
            case 'clients':
                return String(snapshot.clients);
            case 'pending_requests':
                return String(snapshot.pendingRequests);
            case 'worker_ticks':
                return String(snapshot.workerTicks);
            case 'served':
                return String(snapshot.served);
            case 'rejected':
                return String(snapshot.rejected);
            case 'cancelled':
                return String(snapshot.cancelled);
            case 'packet_bytes_sent':
                return String(snapshot.packetBytesSent);
            case 'cache_refreshes':
                return String(snapshot.cacheRefreshes);
            case 'memory_entries':
                return String(this.options.cache.stats().memoryEntries);
            case 'memory_bytes':
                return String(this.options.cache.stats().memoryBytes);
            case 'memory_limit':
                return String(this.options.cache.stats().memoryLimit);
            case 'memory_byte_limit':
                return String(this.options.cache.stats().memoryByteLimit);
            case 'disk_entries':
                return String(this.options.cache.stats().diskEntries);
            case 'disk_bytes':
                return String(this.options.cache.stats().diskBytes);
            case 'disk_limit':
                return String(this.options.cache.stats().diskLimit);
            default:
                return undefined;
        }
    }
}
