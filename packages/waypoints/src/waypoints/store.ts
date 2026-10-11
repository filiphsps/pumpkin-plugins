import type { DataFiles } from '@pumpkin-plugins/plugin-kit/files';
import type { Logger } from '@pumpkin-plugins/plugin-kit/logger';
import { strFromU8, strToU8 } from 'fflate';
import {
    cloneWaypoint,
    createWaypoint,
    isWaypoint,
    normalizeWaypointName,
    type Waypoint,
    waypointNameKey
} from './model.ts';

const STORE_FILE = 'waypoints.json';
const V1_BACKUP_FILE = 'waypoints.v1.json';
const STORE_VERSION = 2;
const LEGACY_VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

/** Stores and validates the v2 waypoint database; v1 files are backed up before migration. */
export class WaypointStore {
    private waypoints = new Map<string, Waypoint>();
    private available = true;
    private invalidReason: string | undefined;

    /** Loads and validates the store once. Invalid files remain untouched and disable writes. */
    constructor(
        private readonly files: DataFiles,
        private readonly logger: Pick<Logger, 'error' | 'warn'>
    ) {
        this.load();
    }

    /** Whether the file was missing or passed complete validation. */
    get isAvailable(): boolean {
        return this.available;
    }

    /** An actionable explanation when an existing store could not be loaded. */
    get error(): string | undefined {
        return this.invalidReason;
    }

    /** Returns a defensive snapshot of records in insertion order. */
    list(): Waypoint[] {
        return [...this.waypoints.values()].map(cloneWaypoint);
    }

    /** Reloads validated disk data, preserving the active catalog if the file cannot be loaded. */
    reload(): boolean {
        const replacement = new WaypointStore(this.files, this.logger);
        if (!replacement.available) return false;
        this.waypoints = replacement.waypoints;
        this.available = true;
        this.invalidReason = undefined;
        return true;
    }

    /** Looks up a waypoint by immutable UUID. */
    get(id: string): Waypoint | undefined {
        const waypoint = this.waypoints.get(id);
        return waypoint === undefined ? undefined : cloneWaypoint(waypoint);
    }

    /** Adds a valid waypoint with a unique UUID and normalized name. */
    add(waypoint: Waypoint): boolean {
        if (!this.available || !isWaypoint(waypoint) || this.waypoints.has(waypoint.id)) return false;
        if (this.nameInUse(waypoint.name)) return false;
        const next = [...this.waypoints.values(), cloneWaypoint(waypoint)];
        this.persist(next);
        this.replace(next);
        return true;
    }

    /** Replaces one waypoint while keeping its UUID and name unique. */
    update(id: string, change: (waypoint: Waypoint) => Waypoint): boolean {
        if (!this.available) return false;
        const current = this.waypoints.get(id);
        if (current === undefined) return false;
        const changed = change(cloneWaypoint(current));
        if (!isWaypoint(changed) || changed.id !== id || this.nameInUse(changed.name, id)) return false;
        const next = [...this.waypoints.values()].map((waypoint) =>
            waypoint.id === id ? cloneWaypoint(changed) : waypoint
        );
        this.persist(next);
        this.replace(next);
        return true;
    }

    /** Removes a waypoint by UUID, writing before changing memory. */
    remove(id: string): boolean {
        if (!this.available || !this.waypoints.has(id)) return false;
        const next = [...this.waypoints.values()].filter((waypoint) => waypoint.id !== id);
        this.persist(next);
        this.replace(next);
        return true;
    }

    private load(): void {
        try {
            const file = this.files.stat(STORE_FILE);
            if (file === undefined) return;
            if (file.kind !== 'file') throw new Error(`${STORE_FILE} is not a regular file.`);

            const bytes = this.files.readFile(STORE_FILE);
            const parsed: unknown = JSON.parse(strFromU8(bytes));
            if (!isRecord(parsed) || !Array.isArray(parsed.waypoints)) {
                throw new Error('expected a versioned object with a waypoints array');
            }
            if (parsed.version === LEGACY_VERSION) {
                this.migrateV1(bytes, parsed.waypoints);
                return;
            }
            if (parsed.version !== STORE_VERSION)
                throw new Error(`unsupported schema version ${String(parsed.version)}`);

            const waypoints = validateV2(parsed.waypoints);
            this.replace(waypoints);
        } catch (error) {
            this.disable(error);
        }
    }

    private migrateV1(originalBytes: Uint8Array, legacyRecords: unknown[]): void {
        const records = validateV1(legacyRecords);
        const usedNames = new Set<string>();
        const migrated = records.map((record) => {
            const name = uniqueName(record.name, usedNames);
            if (name !== record.name) {
                this.logger.warn(
                    `Renamed duplicate legacy waypoint "${record.name}" to "${name}" during v1 migration.`
                );
            }
            usedNames.add(waypointNameKey(name));

            const grants =
                record.visibility === 'public'
                    ? []
                    : [record.ownerId, ...(record.visibility === 'allowlist' ? record.allowedPlayerIds : [])].map(
                          (playerId) => ({ type: 'player' as const, playerId: playerId.toLowerCase() })
                      );
            return createWaypoint({
                id: record.id,
                name,
                dimension: record.dimension,
                position: { x: record.x, y: record.y, z: record.z },
                access: {
                    mode: record.visibility === 'public' ? 'public' : 'restricted',
                    grants
                }
            });
        });

        const validated = validateV2(migrated);
        const serialized = serialize(validated);
        this.backupBeforeMigration(originalBytes);
        this.files.writeFile(STORE_FILE, serialized);
        if (!sameBytes(this.files.readFile(STORE_FILE), serialized)) {
            throw new Error(`could not verify migrated ${STORE_FILE}; the original is preserved in ${V1_BACKUP_FILE}`);
        }
        this.replace(validated);
    }

    private backupBeforeMigration(originalBytes: Uint8Array): void {
        const existing = this.files.stat(V1_BACKUP_FILE);
        if (existing !== undefined) {
            if (existing.kind !== 'file') throw new Error(`${V1_BACKUP_FILE} exists and is not a regular file`);
            const backup = this.files.readFile(V1_BACKUP_FILE);
            if (!sameBytes(backup, originalBytes)) {
                throw new Error(`${V1_BACKUP_FILE} already contains different data; refusing to replace v1 source`);
            }
            return;
        }

        this.files.writeFile(V1_BACKUP_FILE, originalBytes);
        if (!sameBytes(this.files.readFile(V1_BACKUP_FILE), originalBytes)) {
            throw new Error(`could not verify backup ${V1_BACKUP_FILE}; the original is preserved`);
        }
    }

    private persist(waypoints: readonly Waypoint[]): void {
        try {
            this.files.writeFile(STORE_FILE, serialize(waypoints));
        } catch (error) {
            this.logger.error(`Could not save ${STORE_FILE}; no waypoint changes were applied: ${String(error)}`);
            throw error;
        }
    }

    private replace(waypoints: readonly Waypoint[]): void {
        this.waypoints = new Map(waypoints.map((waypoint) => [waypoint.id, cloneWaypoint(waypoint)]));
    }

    private nameInUse(name: string, exceptId?: string): boolean {
        const key = waypointNameKey(name);
        return [...this.waypoints.values()].some(
            (waypoint) => waypoint.id !== exceptId && waypointNameKey(waypoint.name) === key
        );
    }

    private disable(error: unknown): void {
        this.available = false;
        this.invalidReason = error instanceof Error ? error.message : String(error);
        this.logger.error(
            `Could not load ${STORE_FILE}; preserving the file and refusing waypoint writes: ${this.invalidReason}`
        );
    }
}

interface LegacyWaypoint {
    id: string;
    name: string;
    dimension: string;
    x: number;
    y: number;
    z: number;
    ownerId: string;
    visibility: 'private' | 'public' | 'allowlist';
    allowedPlayerIds: string[];
}

function validateV2(values: unknown[]): Waypoint[] {
    const waypoints: Waypoint[] = [];
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const value of values) {
        if (!isWaypoint(value)) throw new Error('one or more v2 waypoint records are invalid');
        const nameKey = waypointNameKey(value.name);
        const id = value.id.toLowerCase();
        if (ids.has(id)) throw new Error(`duplicate waypoint UUID ${id}`);
        if (names.has(nameKey)) throw new Error(`duplicate normalized waypoint name ${value.name}`);
        ids.add(id);
        names.add(nameKey);
        waypoints.push({ ...cloneWaypoint(value), id });
    }
    return waypoints;
}

function validateV1(values: unknown[]): LegacyWaypoint[] {
    const records: LegacyWaypoint[] = [];
    const ids = new Set<string>();
    for (const value of values) {
        if (!isRecord(value)) throw new Error('one or more v1 waypoint records are invalid');
        if (
            typeof value.id !== 'string' ||
            !UUID.test(value.id) ||
            typeof value.name !== 'string' ||
            typeof value.dimension !== 'string' ||
            value.dimension.trim() === '' ||
            !isLegacyCoordinate(value.x) ||
            !isLegacyCoordinate(value.y) ||
            !isLegacyCoordinate(value.z) ||
            typeof value.ownerId !== 'string' ||
            !UUID.test(value.ownerId) ||
            (value.visibility !== 'private' && value.visibility !== 'public' && value.visibility !== 'allowlist') ||
            !Array.isArray(value.allowedPlayerIds) ||
            !value.allowedPlayerIds.every((id) => typeof id === 'string' && UUID.test(id)) ||
            new Set(value.allowedPlayerIds).size !== value.allowedPlayerIds.length ||
            !isLegacyLocatorSettings(value.locatorBar)
        ) {
            throw new Error('one or more v1 waypoint records are invalid');
        }
        const id = value.id.toLowerCase();
        if (ids.has(id)) throw new Error(`duplicate waypoint UUID ${id}`);
        ids.add(id);
        const name = normalizeWaypointName(value.name);
        records.push({
            id,
            name,
            dimension: value.dimension,
            x: value.x,
            y: value.y,
            z: value.z,
            ownerId: value.ownerId,
            visibility: value.visibility,
            allowedPlayerIds: value.allowedPlayerIds
        });
    }
    return records;
}

function uniqueName(base: string, usedNames: ReadonlySet<string>): string {
    const normalized = normalizeWaypointName(base);
    if (!usedNames.has(waypointNameKey(normalized))) return normalized;
    for (let suffix = 2; ; suffix++) {
        const ending = ` (${suffix})`;
        const candidate = `${[...normalized].slice(0, 64 - [...ending].length).join('')}${ending}`;
        if (!usedNames.has(waypointNameKey(candidate))) return candidate;
    }
}

function isLegacyCoordinate(value: unknown): value is number {
    return Number.isInteger(value) && (value as number) >= INT32_MIN && (value as number) <= INT32_MAX;
}

function isLegacyLocatorSettings(value: unknown): boolean {
    if (!isRecord(value) || typeof value.enabled !== 'boolean') return false;
    if (value.color !== undefined && (typeof value.color !== 'string' || !/^#[0-9A-F]{6}$/.test(value.color))) {
        return false;
    }
    if (
        value.javaStyleId !== undefined &&
        (typeof value.javaStyleId !== 'string' || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(value.javaStyleId))
    ) {
        return false;
    }
    return (
        value.bedrockTexture === undefined || (typeof value.bedrockTexture === 'string' && value.bedrockTexture !== '')
    );
}

function serialize(waypoints: readonly Waypoint[]): Uint8Array {
    return strToU8(`${JSON.stringify({ version: STORE_VERSION, waypoints }, null, 4)}\n`);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
