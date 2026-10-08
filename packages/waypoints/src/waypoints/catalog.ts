import { createWaypoint, type NewWaypoint, normalizeWaypointName, type Waypoint, waypointNameKey } from './model.ts';
import type { WaypointStore } from './store.ts';

/** Result of a persisted catalog mutation. */
export type WaypointMutationStatus =
    | 'created'
    | 'updated'
    | 'removed'
    | 'not-found'
    | 'unavailable'
    | 'conflict'
    | 'invalid';

/** Mutable waypoint fields that can be set or reset by an operator. */
export type WaypointMetadataPatch = Partial<
    Pick<Waypoint, 'label' | 'description' | 'color' | 'icon' | 'visibilityRange' | 'enabled' | 'access'>
>;

/** Owns name lookup and persisted mutations while keeping waypoint identity stable. */
export class WaypointCatalog {
    constructor(
        private readonly store: WaypointStore,
        private readonly onChange?: (waypointId: string) => void
    ) {}

    /** Whether the canonical waypoint store can be read and written. */
    get isAvailable(): boolean {
        return this.store.isAvailable;
    }

    /** Returns all saved waypoints in stable insertion order. */
    list(): Waypoint[] {
        return this.store.list();
    }

    /** Looks up an immutable waypoint UUID. */
    getById(id: string): Waypoint | undefined {
        return this.store.get(id);
    }

    /** Looks up by Unicode-normalized, case-insensitive public name. */
    getByName(name: string): Waypoint | undefined {
        let key: string;
        try {
            key = waypointNameKey(name);
        } catch {
            return undefined;
        }
        return this.store.list().find((waypoint) => waypointNameKey(waypoint.name) === key);
    }

    /** Creates a waypoint, rejecting duplicate normalized names and UUIDs. */
    create(input: NewWaypoint): MutationResult {
        if (!this.store.isAvailable) return { status: 'unavailable' };
        let waypoint: Waypoint;
        try {
            waypoint = createWaypoint(input);
        } catch {
            return { status: 'invalid' };
        }
        if (this.store.get(waypoint.id) !== undefined || this.getByName(waypoint.name) !== undefined) {
            return { status: 'conflict' };
        }
        try {
            if (!this.store.add(waypoint)) return { status: this.store.isAvailable ? 'conflict' : 'unavailable' };
        } catch {
            return { status: 'unavailable' };
        }
        this.onChange?.(waypoint.id);
        return { status: 'created', waypoint };
    }

    /** Renames a waypoint without changing its UUID. */
    rename(name: string, newName: string): MutationResult {
        return this.update(name, (waypoint) => ({ ...waypoint, name: normalizeWaypointName(newName) }));
    }

    /** Relocates a waypoint to exact coordinates in a stable world key. */
    relocate(name: string, dimension: string, position: Waypoint['position']): MutationResult {
        return this.update(name, (waypoint) => ({ ...waypoint, dimension, position }));
    }

    /** Updates optional metadata and ACL fields, validating the whole candidate before persistence. */
    update(name: string, change: ((waypoint: Waypoint) => NewWaypoint) | WaypointMetadataPatch): MutationResult {
        if (!this.store.isAvailable) return { status: 'unavailable' };
        const current = this.getByName(name);
        if (current === undefined) return { status: 'not-found' };

        let changed: Waypoint;
        try {
            const candidate = typeof change === 'function' ? change(current) : { ...current, ...change };
            changed = createWaypoint(candidate);
        } catch {
            return { status: 'invalid' };
        }
        const duplicate = this.getByName(changed.name);
        if (duplicate !== undefined && duplicate.id !== current.id) return { status: 'conflict' };
        try {
            if (!this.store.update(current.id, () => changed)) {
                return { status: this.store.isAvailable ? 'invalid' : 'unavailable' };
            }
        } catch {
            return { status: 'unavailable' };
        }
        this.onChange?.(current.id);
        return { status: 'updated', waypoint: changed };
    }

    /** Sets enabled state; repeated requests do not rewrite the store. */
    setEnabled(name: string, enabled: boolean): MutationResult {
        const current = this.getByName(name);
        if (current === undefined) return { status: this.store.isAvailable ? 'not-found' : 'unavailable' };
        if (current.enabled === enabled) return { status: 'updated', waypoint: current };
        return this.update(name, { enabled });
    }

    /** Deletes by public name. */
    remove(name: string): MutationResult {
        if (!this.store.isAvailable) return { status: 'unavailable' };
        const waypoint = this.getByName(name);
        if (waypoint === undefined) return { status: 'not-found' };
        try {
            if (!this.store.remove(waypoint.id)) return { status: this.store.isAvailable ? 'invalid' : 'unavailable' };
        } catch {
            return { status: 'unavailable' };
        }
        this.onChange?.(waypoint.id);
        return { status: 'removed', waypoint };
    }
}

/** Result of a catalog mutation. */
export interface MutationResult {
    readonly status: WaypointMutationStatus;
    readonly waypoint?: Waypoint;
}
