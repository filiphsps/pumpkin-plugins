import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { ipcSend } from '@pumpkin-plugins/plugin-kit/ipc';
import {
    type ExpansionHandler,
    LIMITS,
    PieSession,
    type SendMessage,
    type SessionState,
} from '@pumpkin-plugins/pumpkin-pie-api';
import { waypointPlaceholderNames } from './definitions.ts';
import { withWaypointViewer } from './pumpkin-context.ts';
import type { PlaceholderFailure, WaypointCatalogReader } from './resolver.ts';
import { parsePlaceholder, resolvePlaceholder } from './resolver.ts';

/** Dependencies for the optional PumpkinPIE integration and its host-independent seams. */
export interface WaypointPlaceholderServiceOptions {
    /** Monotonic time in milliseconds for provider negotiation and recovery. */
    readonly now: () => number;
    /** Reports one bounded diagnostic when query failures begin. */
    readonly onFailure?: (identifier: string, reason: PlaceholderFailure) => void;
    /** Reports provider state changes without exposing transport errors. */
    readonly onTransition?: (state: SessionState) => void;
    /** Host IPC transport; production uses plugin-kit and tests can inject a scripted transport. */
    readonly send?: SendMessage;
}

/** Owns the Waypoints namespace, live viewer callbacks, and one recoverable PIE session. */
export class WaypointPlaceholderService {
    private readonly session: PieSession;
    private queryFailureActive = false;

    constructor(
        private readonly server: Server,
        private readonly catalog: WaypointCatalogReader,
        options: WaypointPlaceholderServiceOptions,
    ) {
        this.session = new PieSession({
            send: options.send ?? ipcSend,
            now: options.now,
            onTransition: options.onTransition,
        });
        const handlers: Record<string, ExpansionHandler> = {};
        for (const name of waypointPlaceholderNames) {
            handlers[name] = ({ viewer, argument }) => this.resolve(name, viewer, argument, options.onFailure);
        }
        this.session.registerExpansion('waypoints', handlers, { kind: 'never' });
    }

    /** Negotiates the provider and renews the namespace after recovery. */
    tick(): void {
        this.session.tick();
    }

    /** Routes only the actual Pumpkin callback sender and payload through the shared API router. */
    handleIpcMessage(sender: string, message: Uint8Array): Uint8Array {
        return this.session.router.handle(sender, message);
    }

    /** Stops the session without sending IPC while the Pumpkin host is unloading. */
    stop(): void {
        this.session.stop({ unregister: false });
    }

    private resolve(
        name: string,
        viewerName: string | undefined,
        argument: string | undefined,
        onFailure: WaypointPlaceholderServiceOptions['onFailure'],
    ): string | undefined {
        if (viewerName === undefined || parsePlaceholder(name, argument) === undefined) return undefined;
        let enteredViewer = false;
        let failureReported = false;
        try {
            const value = withWaypointViewer(this.server, viewerName, (viewer) => {
                enteredViewer = true;
                return resolvePlaceholder(name, argument, this.catalog, viewer, (identifier, reason) => {
                    failureReported = true;
                    this.reportFailure(identifier, reason, onFailure);
                });
            });
            if (enteredViewer && !failureReported) this.queryFailureActive = false;
            return value;
        } catch {
            this.reportFailure(name, 'query_failed', onFailure);
            return undefined;
        }
    }

    private reportFailure(
        identifier: string,
        reason: PlaceholderFailure,
        onFailure: WaypointPlaceholderServiceOptions['onFailure'],
    ): void {
        if (this.queryFailureActive) return;
        this.queryFailureActive = true;
        try {
            onFailure?.(identifier.slice(0, LIMITS.id), reason);
        } catch {
            // Diagnostics must not change the provider's declined-value response.
        }
    }
}
