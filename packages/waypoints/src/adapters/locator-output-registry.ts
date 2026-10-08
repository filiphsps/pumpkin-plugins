import type { WaypointService } from '../waypoints/service.ts';
import { JavaLocatorBarOutput, type ParseWaypointId } from './java-locator-bar.ts';

/** Edition and capability keys for waypoint locator outputs. */
export type LocatorOutputKey = 'java:locator-bar' | 'bedrock:locator-bar';

/** Lifecycle surface shared by edition-specific Locator Bar adapters. */
export interface LocatorOutputAdapter {
    /** Edition and capability implemented by this adapter. */
    readonly key: LocatorOutputKey;
    /** Sends current authorized markers to one recipient. */
    reconcile: JavaLocatorBarOutput['reconcile'];
    /** Removes session markers before unloading. */
    clear: JavaLocatorBarOutput['clear'];
    /** Forgets state after a recipient leaves. */
    forgetPlayer: JavaLocatorBarOutput['forgetPlayer'];
}

/** Edition-specific output registry, kept separate from map-import adapters. */
export type LocatorOutputRegistry = Readonly<Partial<Record<LocatorOutputKey, LocatorOutputAdapter>>>;

/** Registers the currently supported Java Locator Bar output. */
export function createLocatorOutputRegistry(
    waypoints: WaypointService,
    parseId: ParseWaypointId
): LocatorOutputRegistry {
    const javaLocatorBar = new JavaLocatorBarOutput(waypoints, parseId);
    return { [javaLocatorBar.key]: javaLocatorBar };
}
