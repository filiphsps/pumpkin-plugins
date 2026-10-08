import type { Waypoint } from '../waypoints/model.ts';
import type { WaypointActor, WaypointService } from '../waypoints/service.ts';

/** A message target for one-to-one map imports. */
export interface MapRecipient extends WaypointActor {
    /** Sends a readable system message only to this recipient. */
    sendSystemMessage(message: string): void;
}

/** Result from a map-specific adapter. */
export type MapAdapterResult =
    | { readonly status: 'delivered' }
    | { readonly status: 'unavailable'; readonly reason: string };

/** Adapter contract for a map import format. */
export interface WaypointMapAdapter {
    /** Sends the format-specific payload to one recipient. */
    deliver(waypoint: Waypoint, recipient: MapRecipient): MapAdapterResult;
}

/** Result from access-controlled waypoint delivery. */
export type MapDeliveryResult =
    | MapAdapterResult
    | { readonly status: 'not-found' }
    | { readonly status: 'unsupported'; readonly reason: string };

/** The adapters registered for named map-import channels. */
export type WaypointMapAdapterRegistry = Readonly<Record<string, WaypointMapAdapter>>;

/** Checks both sender and recipient access before selecting a map adapter. */
export class MapDeliveryService {
    /** Creates the map delivery dispatcher. */
    constructor(
        private readonly waypoints: WaypointService,
        private readonly adapters: WaypointMapAdapterRegistry
    ) {}

    /** Delivers only when both parties may access the waypoint. */
    send(sender: WaypointActor, recipient: MapRecipient, waypointId: string, adapterId: string): MapDeliveryResult {
        if (!this.waypoints.isAvailable) return { status: 'unavailable', reason: 'The waypoint store is unavailable.' };
        const waypoint = this.waypoints.getFor(sender, waypointId);
        if (waypoint === undefined || this.waypoints.getFor(recipient, waypointId) === undefined)
            return { status: 'not-found' };

        if (!Object.hasOwn(this.adapters, adapterId)) {
            return { status: 'unsupported', reason: `Unknown map adapter: ${adapterId}.` };
        }
        return (
            this.adapters[adapterId]?.deliver(waypoint, recipient) ?? {
                status: 'unsupported',
                reason: `Unknown map adapter: ${adapterId}.`
            }
        );
    }
}

/** Xaero's public share text remains unavailable until a current client fixture is verified. */
export class XaeroShareAdapter implements WaypointMapAdapter {
    /** Returns a typed capability result without sending an unverified payload. */
    deliver(_waypoint: Waypoint, _recipient: MapRecipient): MapAdapterResult {
        return {
            status: 'unavailable',
            reason: 'Xaero import is unavailable until a current client share fixture and server-sent import behavior are verified.'
        };
    }
}

/** Registered map-import adapter modules, separate from edition-specific locator outputs. */
export const waypointMapAdapters = {
    'xaero-share': new XaeroShareAdapter()
} satisfies WaypointMapAdapterRegistry;
