import type { DataFiles } from '@pumpkin-plugins/plugin-kit/files';
import type { Logger } from '@pumpkin-plugins/plugin-kit/logger';
import { strFromU8, strToU8 } from 'fflate';
import type { Waypoint, WaypointLocatorSettings, WaypointVisibility } from './model.ts';

const STORE_FILE = 'waypoints.json';
const STORE_VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOURCE_ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const COLOR = /^#[0-9A-F]{6}$/;
const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

/** Stores and validates the versioned waypoint database in the plugin data folder. */
export class WaypointStore {
    private waypoints = new Map<string, Waypoint>();
    private available = true;
    private invalidReason: string | undefined;

    /** Loads and validates existing records once. Invalid files remain untouched and disable writes. */
    constructor(
        private readonly files: DataFiles,
        private readonly logger: Pick<Logger, 'error'>
    ) {
        this.load();
    }

    /** Whether the file was missing or passed the complete schema check. */
    get isAvailable(): boolean {
        return this.available;
    }

    /** An actionable explanation when an existing store could not be loaded. */
    get error(): string | undefined {
        return this.invalidReason;
    }

    /** Returns a defensive snapshot of the records in insertion order. */
    list(): Waypoint[] {
        return [...this.waypoints.values()].map(cloneWaypoint);
    }

    /** Looks up a waypoint by its immutable UUID. */
    get(id: string): Waypoint | undefined {
        const waypoint = this.waypoints.get(id);
        return waypoint === undefined ? undefined : cloneWaypoint(waypoint);
    }

    /** Adds a uniquely identified waypoint, writing it before changing memory. */
    add(waypoint: Waypoint): boolean {
        if (!this.available || !isWaypoint(waypoint) || this.waypoints.has(waypoint.id)) return false;
        const next = [...this.waypoints.values(), cloneWaypoint(waypoint)];
        this.persist(next);
        this.waypoints = new Map(next.map((entry) => [entry.id, entry]));
        return true;
    }

    /** Replaces one waypoint while keeping its UUID unchanged. */
    update(id: string, change: (waypoint: Waypoint) => Waypoint): boolean {
        if (!this.available) return false;
        const current = this.waypoints.get(id);
        if (current === undefined) return false;
        const changed = change(cloneWaypoint(current));
        if (changed.id !== id || !isWaypoint(changed)) return false;
        const next = [...this.waypoints.values()].map((waypoint) =>
            waypoint.id === id ? cloneWaypoint(changed) : waypoint
        );
        this.persist(next);
        this.waypoints = new Map(next.map((entry) => [entry.id, entry]));
        return true;
    }

    /** Removes a waypoint by UUID, writing the change before changing memory. */
    remove(id: string): boolean {
        if (!this.available || !this.waypoints.has(id)) return false;
        const next = [...this.waypoints.values()].filter((waypoint) => waypoint.id !== id);
        this.persist(next);
        this.waypoints = new Map(next.map((entry) => [entry.id, entry]));
        return true;
    }

    private load(): void {
        try {
            const file = this.files.stat(STORE_FILE);
            if (file === undefined) return;
            if (file.kind !== 'file') throw new Error(`${STORE_FILE} is not a regular file.`);

            const parsed: unknown = JSON.parse(strFromU8(this.files.readFile(STORE_FILE)));
            if (!isRecord(parsed) || parsed.version !== STORE_VERSION || !Array.isArray(parsed.waypoints)) {
                throw new Error(`expected schema version ${STORE_VERSION} with a waypoints array`);
            }

            const waypoints: Waypoint[] = [];
            const ids = new Set<string>();
            for (const value of parsed.waypoints) {
                if (!isWaypoint(value)) throw new Error('one or more waypoint records are invalid');
                if (ids.has(value.id)) throw new Error(`duplicate waypoint UUID ${value.id}`);
                ids.add(value.id);
                waypoints.push(cloneWaypoint(value));
            }
            this.waypoints = new Map(waypoints.map((waypoint) => [waypoint.id, waypoint]));
        } catch (error) {
            this.available = false;
            this.invalidReason = error instanceof Error ? error.message : String(error);
            this.logger.error(
                `Could not load ${STORE_FILE}; preserving the file and refusing waypoint writes: ${this.invalidReason}`
            );
        }
    }

    private persist(waypoints: readonly Waypoint[]): void {
        try {
            this.files.writeFile(STORE_FILE, strToU8(JSON.stringify({ version: STORE_VERSION, waypoints })));
        } catch (error) {
            this.logger.error(`Could not save ${STORE_FILE}; no waypoint changes were applied: ${String(error)}`);
            throw error;
        }
    }
}

function isWaypoint(value: unknown): value is Waypoint {
    if (!isRecord(value)) return false;
    return (
        typeof value.id === 'string' &&
        UUID.test(value.id) &&
        typeof value.name === 'string' &&
        value.name.trim().length > 0 &&
        typeof value.dimension === 'string' &&
        value.dimension.length > 0 &&
        isBlockCoordinate(value.x) &&
        isBlockCoordinate(value.y) &&
        isBlockCoordinate(value.z) &&
        typeof value.ownerId === 'string' &&
        UUID.test(value.ownerId) &&
        isVisibility(value.visibility) &&
        Array.isArray(value.allowedPlayerIds) &&
        value.allowedPlayerIds.every((id) => typeof id === 'string' && UUID.test(id)) &&
        new Set(value.allowedPlayerIds).size === value.allowedPlayerIds.length &&
        isLocatorSettings(value.locatorBar)
    );
}

function isLocatorSettings(value: unknown): value is WaypointLocatorSettings {
    if (!isRecord(value) || typeof value.enabled !== 'boolean') return false;
    if (value.color !== undefined && (typeof value.color !== 'string' || !COLOR.test(value.color))) return false;
    if (
        value.javaStyleId !== undefined &&
        (typeof value.javaStyleId !== 'string' || !RESOURCE_ID.test(value.javaStyleId))
    ) {
        return false;
    }
    return (
        value.bedrockTexture === undefined ||
        (typeof value.bedrockTexture === 'string' && value.bedrockTexture.length > 0)
    );
}

function isVisibility(value: unknown): value is WaypointVisibility {
    return value === 'private' || value === 'public' || value === 'allowlist';
}

function isBlockCoordinate(value: unknown): value is number {
    return Number.isInteger(value) && (value as number) >= INT32_MIN && (value as number) <= INT32_MAX;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneWaypoint(waypoint: Waypoint): Waypoint {
    return {
        ...waypoint,
        allowedPlayerIds: [...waypoint.allowedPlayerIds],
        locatorBar: { ...waypoint.locatorBar }
    };
}
