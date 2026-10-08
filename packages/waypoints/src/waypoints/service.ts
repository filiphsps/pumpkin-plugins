import {
    canManageWaypoint,
    canViewWaypoint,
    createWaypoint,
    type NewWaypoint,
    type Waypoint,
    type WaypointVisibility
} from './model.ts';
import type { WaypointStore } from './store.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOURCE_ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

/** The stable identity and operator status used for one service operation. */
export interface WaypointActor {
    readonly playerId: string;
    readonly isOperator: boolean;
}

/** A result shared by waypoint creation and mutations. */
export type WaypointMutationResult =
    | 'created'
    | 'updated'
    | 'removed'
    | 'not-found'
    | 'unavailable'
    | 'conflict'
    | 'invalid';

/** Input to create a waypoint; its owner always comes from the actor. */
export type CreateWaypointInput = Omit<NewWaypoint, 'ownerId'>;

/** Applies object-level access checks before listing, returning, changing, or removing waypoints. */
export class WaypointService {
    /** Creates a service over the validated store. */
    constructor(
        private readonly store: WaypointStore,
        private readonly onChange?: () => void
    ) {}

    /** Whether a valid database is available for reads and writes. */
    get isAvailable(): boolean {
        return this.store.isAvailable;
    }

    /** Returns accessible waypoints, optionally limited to one current dimension. */
    listFor(actor: WaypointActor, dimension?: string): Waypoint[] | undefined {
        if (!this.store.isAvailable) return undefined;
        return this.store
            .list()
            .filter(
                (waypoint) =>
                    (dimension === undefined || waypoint.dimension === dimension) &&
                    canViewWaypoint(waypoint, actor.playerId, actor.isOperator)
            );
    }

    /** Returns a waypoint only when the actor may view it; missing and inaccessible IDs are indistinguishable. */
    getFor(actor: WaypointActor, id: string): Waypoint | undefined {
        const waypoint = this.store.get(id);
        return waypoint !== undefined && canViewWaypoint(waypoint, actor.playerId, actor.isOperator)
            ? waypoint
            : undefined;
    }

    /** Lists every record only for an operator. */
    listAll(actor: WaypointActor): Waypoint[] | undefined {
        if (!actor.isOperator || !this.store.isAvailable) return undefined;
        return this.store.list();
    }

    /** Creates a private waypoint owned by the actor. */
    create(actor: WaypointActor, input: CreateWaypointInput): WaypointMutationResult {
        if (!this.store.isAvailable) return 'unavailable';
        const waypoint = createWaypoint({ ...input, ownerId: actor.playerId });
        if (this.store.get(waypoint.id) !== undefined) return 'conflict';
        try {
            if (!this.store.add(waypoint)) return this.store.isAvailable ? 'invalid' : 'unavailable';
        } catch {
            return 'unavailable';
        }
        this.onChange?.();
        return 'created';
    }

    /** Changes visibility for the owner or an operator. */
    setVisibility(actor: WaypointActor, id: string, visibility: WaypointVisibility): WaypointMutationResult {
        return this.update(actor, id, (waypoint) => ({ ...waypoint, visibility }));
    }

    /** Adds a player's UUID to the allowlist. */
    addRecipient(actor: WaypointActor, id: string, recipientId: string): WaypointMutationResult {
        if (!UUID.test(recipientId)) return 'invalid';
        return this.update(actor, id, (waypoint) => ({
            ...waypoint,
            allowedPlayerIds: waypoint.allowedPlayerIds.includes(recipientId)
                ? [...waypoint.allowedPlayerIds]
                : [...waypoint.allowedPlayerIds, recipientId]
        }));
    }

    /** Removes a player's UUID from the allowlist. */
    removeRecipient(actor: WaypointActor, id: string, recipientId: string): WaypointMutationResult {
        if (!UUID.test(recipientId)) return 'invalid';
        return this.update(actor, id, (waypoint) => ({
            ...waypoint,
            allowedPlayerIds: waypoint.allowedPlayerIds.filter((playerId) => playerId !== recipientId)
        }));
    }

    /** Enables or disables locator output for the owner or an operator. */
    setLocatorEnabled(actor: WaypointActor, id: string, enabled: boolean): WaypointMutationResult {
        return this.update(actor, id, (waypoint) => ({
            ...waypoint,
            locatorBar: { ...waypoint.locatorBar, enabled }
        }));
    }

    /** Sets a canonical RGB color, or clears it when undefined. */
    setLocatorColor(actor: WaypointActor, id: string, color: string | undefined): WaypointMutationResult {
        if (color !== undefined && !COLOR.test(color)) return 'invalid';
        const normalizedColor = color?.toUpperCase();
        return this.update(actor, id, (waypoint) => {
            const { color: _color, ...settings } = waypoint.locatorBar;
            return {
                ...waypoint,
                locatorBar: normalizedColor === undefined ? settings : { ...settings, color: normalizedColor }
            };
        });
    }

    /** Sets a Java waypoint style resource ID, or returns to the default style when undefined. */
    setJavaStyle(actor: WaypointActor, id: string, javaStyleId: string | undefined): WaypointMutationResult {
        if (javaStyleId !== undefined && !RESOURCE_ID.test(javaStyleId)) return 'invalid';
        return this.update(actor, id, (waypoint) => {
            const { javaStyleId: _styleId, ...settings } = waypoint.locatorBar;
            return {
                ...waypoint,
                locatorBar: javaStyleId === undefined ? settings : { ...settings, javaStyleId }
            };
        });
    }

    /** Removes a waypoint for its owner or an operator. */
    remove(actor: WaypointActor, id: string): WaypointMutationResult {
        if (!this.store.isAvailable) return 'unavailable';
        const waypoint = this.store.get(id);
        if (waypoint === undefined || !canManageWaypoint(waypoint, actor.playerId, actor.isOperator))
            return 'not-found';
        try {
            if (!this.store.remove(id)) return this.store.isAvailable ? 'invalid' : 'unavailable';
        } catch {
            return 'unavailable';
        }
        this.onChange?.();
        return 'removed';
    }

    private update(actor: WaypointActor, id: string, change: (waypoint: Waypoint) => Waypoint): WaypointMutationResult {
        if (!this.store.isAvailable) return 'unavailable';
        const current = this.store.get(id);
        if (current === undefined || !canManageWaypoint(current, actor.playerId, actor.isOperator)) return 'not-found';
        try {
            if (!this.store.update(id, change)) return this.store.isAvailable ? 'invalid' : 'unavailable';
        } catch {
            return 'unavailable';
        }
        this.onChange?.();
        return 'updated';
    }
}
