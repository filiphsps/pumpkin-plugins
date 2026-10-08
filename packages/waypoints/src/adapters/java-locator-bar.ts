import type { JavaPacket, Uuid } from 'pumpkin:plugin/player@0.1.0';
import type { Waypoint, WaypointLocatorSettings } from '../waypoints/model.ts';
import type { WaypointActor, WaypointService } from '../waypoints/service.ts';

const RESOURCE_ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_ICON_COLOR = 0xffffff;

/** A connected recipient accepted by the Java Locator Bar output. */
export interface JavaLocatorRecipient extends WaypointActor {
    /** The world's name, used because c-waypoint has no dimension field. */
    readonly dimension: string;
    /** Whether this recipient is connected through Java Edition. */
    readonly isJava: boolean;
    /** Sends a Java packet to this recipient. */
    sendPacket(packet: JavaPacket): void;
}

/** Parses a canonical waypoint UUID into Pumpkin's UUID record. */
export type ParseWaypointId = (id: string) => Uuid | undefined;

/** Creates a c-waypoint packet with a fixed integer position or an empty untrack target. */
export function toJavaWaypointPacket(
    waypoint: Waypoint,
    operation: 'track' | 'update' | 'untrack',
    identifier: Uuid
): JavaPacket {
    const icon = operation === 'untrack' ? undefined : iconFor(waypoint.locatorBar);
    return {
        tag: 'c-waypoint',
        val: {
            operation,
            waypoint: {
                identifier,
                ...(icon === undefined ? {} : { icon }),
                target:
                    operation === 'untrack'
                        ? { tag: 'empty' }
                        : { tag: 'position', val: [waypoint.x, waypoint.y, waypoint.z] }
            }
        }
    };
}

/** Reconciles Java Locator Bar markers against current dimension and access policy. */
export class JavaLocatorBarOutput {
    /** Edition and capability key used to keep locator outputs separate from map imports. */
    readonly key = 'java:locator-bar' as const;
    private readonly trackedByPlayer = new Map<string, Map<string, TrackedMarker>>();

    /** Creates the Java output adapter. */
    constructor(
        private readonly waypoints: WaypointService,
        private readonly parseId: ParseWaypointId
    ) {}

    /** Sends only currently enabled, accessible, same-dimension waypoints to this Java player. */
    reconcile(recipient: JavaLocatorRecipient, forceReset = false): void {
        if (!recipient.isJava) {
            this.forgetPlayer(recipient.playerId);
            return;
        }

        const previous = this.trackedByPlayer.get(recipient.playerId) ?? new Map<string, TrackedMarker>();
        const accessible = this.waypoints.listFor(recipient);
        const current = accessible ?? [];
        const desired = current.filter(
            (waypoint) => waypoint.locatorBar.enabled && waypoint.dimension === recipient.dimension
        );
        const desiredById = new Map(desired.map((waypoint) => [waypoint.id, waypoint]));
        const tracked = new Map(previous);

        if (forceReset) {
            const reset = new Map<string, Waypoint>();
            for (const marker of previous.values()) reset.set(marker.waypoint.id, marker.waypoint);
            for (const waypoint of current) reset.set(waypoint.id, waypoint);
            for (const waypoint of reset.values()) {
                if (this.send(recipient, waypoint, 'untrack')) tracked.delete(waypoint.id);
            }
        }

        for (const [id, marker] of tracked) {
            if (desiredById.has(id)) continue;
            if (this.send(recipient, marker.waypoint, 'untrack')) tracked.delete(id);
        }

        for (const waypoint of desired) {
            const prior = tracked.get(waypoint.id);
            const fingerprint = markerFingerprint(waypoint);
            if (prior?.fingerprint === fingerprint) continue;
            const operation = prior === undefined ? 'track' : 'update';
            if (this.send(recipient, waypoint, operation)) tracked.set(waypoint.id, { waypoint, fingerprint });
        }

        if (tracked.size === 0) this.trackedByPlayer.delete(recipient.playerId);
        else this.trackedByPlayer.set(recipient.playerId, tracked);
    }

    /** Drops transient session state after a player disconnects. */
    forgetPlayer(playerId: string): void {
        this.trackedByPlayer.delete(playerId);
    }

    /** Sends untrack packets for this session before the plugin unloads. */
    clear(recipient: JavaLocatorRecipient): void {
        if (!recipient.isJava) {
            this.forgetPlayer(recipient.playerId);
            return;
        }
        const markers = new Map<string, Waypoint>();
        for (const marker of this.trackedByPlayer.get(recipient.playerId)?.values() ?? []) {
            markers.set(marker.waypoint.id, marker.waypoint);
        }
        for (const waypoint of this.waypoints.listFor(recipient) ?? []) markers.set(waypoint.id, waypoint);
        try {
            for (const waypoint of markers.values()) this.send(recipient, waypoint, 'untrack');
        } finally {
            this.forgetPlayer(recipient.playerId);
        }
    }

    private send(
        recipient: JavaLocatorRecipient,
        waypoint: Waypoint,
        operation: 'track' | 'update' | 'untrack'
    ): boolean {
        const identifier = this.parseId(waypoint.id);
        if (identifier === undefined) return false;
        recipient.sendPacket(toJavaWaypointPacket(waypoint, operation, identifier));
        return true;
    }
}

interface TrackedMarker {
    readonly waypoint: Waypoint;
    readonly fingerprint: string;
}

function iconFor(settings: WaypointLocatorSettings): { style?: string; color: number } | undefined {
    if (settings.color === undefined && settings.javaStyleId === undefined) return undefined;
    if (settings.color !== undefined && !COLOR.test(settings.color)) throw new Error('Invalid waypoint color.');
    if (settings.javaStyleId !== undefined && !RESOURCE_ID.test(settings.javaStyleId)) {
        throw new Error('Invalid waypoint style ID.');
    }
    const color = settings.color === undefined ? DEFAULT_ICON_COLOR : Number.parseInt(settings.color.slice(1), 16);
    return settings.javaStyleId === undefined ? { color } : { style: settings.javaStyleId, color };
}

function markerFingerprint(waypoint: Waypoint): string {
    return JSON.stringify([
        waypoint.dimension,
        waypoint.x,
        waypoint.y,
        waypoint.z,
        waypoint.locatorBar.color,
        waypoint.locatorBar.javaStyleId
    ]);
}
