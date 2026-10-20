const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR = /^#(?:[0-9a-f]{6})$/i;
const COLOR_INPUT = /^#?(?:[0-9a-f]{6})$/i;
const ITEM_ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const PERMISSION_NODE = /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/;
const GROUP_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CONTROL = /\p{Cc}/u;
const MAX_HORIZONTAL_COORDINATE = 30_000_000;
// Vanilla /tp rejects a Y beyond this.
const MAX_VERTICAL_COORDINATE = 20_000_000;
const MAX_VISIBILITY_RANGE = 30_000_000;

/** A location in a named Pumpkin world. */
export interface WaypointPosition {
    readonly x: number;
    readonly y: number;
    readonly z: number;
}

/** A persisted access grant. Grants are additive. */
export type AccessGrant =
    | { readonly type: 'player'; readonly playerId: string }
    | { readonly type: 'permission'; readonly node: string }
    | { readonly type: 'group'; readonly slug: string };

/** Access policy for a shared server waypoint. */
export interface WaypointAccess {
    readonly grants: readonly AccessGrant[];
    readonly mode: 'restricted' | 'public';
}

/** Canonical server-owned waypoint record. Presentation state is intentionally not persisted here. */
export interface Waypoint {
    readonly access: WaypointAccess;
    readonly color: string;
    readonly description?: string;
    readonly dimension: string;
    readonly enabled: boolean;
    readonly icon?: string;
    readonly id: string;
    readonly label?: string;
    readonly name: string;
    readonly position: WaypointPosition;
    readonly visibilityRange?: number;
}

/** Checks whether text uses the canonical hyphenated UUID shape accepted by waypoint records. */
export function isWaypointId(value: string): boolean {
    return UUID.test(value);
}

/** Input required to create a waypoint; defaults are applied to optional metadata and access. */
export interface NewWaypoint {
    readonly access?: WaypointAccess;
    readonly color?: string;
    readonly description?: string;
    readonly dimension: string;
    readonly enabled?: boolean;
    readonly icon?: string;
    readonly id: string;
    readonly label?: string;
    readonly name: string;
    readonly position: WaypointPosition;
    readonly visibilityRange?: number;
}

/** Defaults for waypoint metadata, shared by creation and `/wp reset`. */
export const WAYPOINT_METADATA_DEFAULTS = {
    label: undefined,
    description: undefined,
    color: '#FFFFFF',
    icon: undefined,
    visibilityRange: undefined,
} as const satisfies Partial<Pick<Waypoint, 'label' | 'description' | 'color' | 'icon' | 'visibilityRange'>>;

// Enabled state and access have their own commands, so `/wp reset` leaves them alone.
const DEFAULT_ACCESS: WaypointAccess = { mode: 'restricted', grants: [] };

/** A metadata key that `/wp reset` can restore to its default. */
export type WaypointMetadataKey = keyof typeof WAYPOINT_METADATA_DEFAULTS;

/** Normalizes a waypoint key while preserving its display spelling. */
export function normalizeWaypointName(name: string): string {
    if (typeof name !== 'string') throw new TypeError('Waypoint name must be text.');
    const normalized = name.trim().normalize('NFC');
    if ([...normalized].length < 1 || [...normalized].length > 64 || CONTROL.test(normalized)) {
        throw new TypeError('Waypoint names must contain 1 to 64 non-control characters.');
    }
    return normalized;
}

/** A stable Unicode-normalized, case-insensitive lookup key. */
export function waypointNameKey(name: string): string {
    return normalizeWaypointName(name).toLowerCase().normalize('NFC');
}

/** Canonicalizes an item key, treating unqualified keys as vanilla Minecraft IDs. */
export function normalizeItemIdentifier(value: string): string {
    if (typeof value !== 'string') throw new TypeError('Waypoint icon must be an item identifier.');
    const identifier = value.includes(':') ? value : `minecraft:${value}`;
    if (!ITEM_ID.test(identifier)) throw new TypeError('Waypoint icon must be a valid item identifier.');
    return identifier;
}

/** Creates a validated waypoint with canonical metadata and restricted access by default. */
export function createWaypoint(input: NewWaypoint): Waypoint {
    if (!isWaypointId(input.id)) throw new TypeError('Waypoint id must be a UUID.');
    const name = normalizeWaypointName(input.name);
    if (typeof input.dimension !== 'string' || input.dimension.trim() === '' || CONTROL.test(input.dimension)) {
        throw new TypeError('Waypoint dimension must not be empty or contain control characters.');
    }

    const position = normalizePosition(input.position);
    const color = normalizeColor(input.color ?? WAYPOINT_METADATA_DEFAULTS.color);
    const icon = normalizeIcon(input.icon === undefined ? WAYPOINT_METADATA_DEFAULTS.icon : input.icon);
    const label = normalizeText(input.label === undefined ? WAYPOINT_METADATA_DEFAULTS.label : input.label, 'label');
    const description = normalizeText(
        input.description === undefined ? WAYPOINT_METADATA_DEFAULTS.description : input.description,
        'description',
    );
    const visibilityRange = normalizeVisibilityRange(
        input.visibilityRange === undefined ? WAYPOINT_METADATA_DEFAULTS.visibilityRange : input.visibilityRange,
    );
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
        throw new TypeError('Waypoint enabled state must be boolean.');
    }
    const access = normalizeAccess(input.access ?? DEFAULT_ACCESS);
    const waypoint: Waypoint = {
        id: input.id.toLowerCase(),
        name,
        dimension: input.dimension,
        position,
        ...(label === undefined ? {} : { label }),
        ...(description === undefined ? {} : { description }),
        color,
        ...(icon === undefined ? {} : { icon }),
        ...(visibilityRange === undefined ? {} : { visibilityRange }),
        enabled: input.enabled ?? true,
        access,
    };
    if (!isWaypoint(waypoint)) throw new TypeError('Waypoint data is invalid.');
    return waypoint;
}

/** Checks the complete persisted v2 record shape without coercing values. */
export function isWaypoint(value: unknown): value is Waypoint {
    if (!isRecord(value) || !hasOnlyKeys(value, waypointKeys)) return false;
    if (
        typeof value.id !== 'string' ||
        !isWaypointId(value.id) ||
        typeof value.name !== 'string' ||
        typeof value.dimension !== 'string' ||
        value.dimension.trim() === '' ||
        CONTROL.test(value.dimension) ||
        typeof value.color !== 'string' ||
        !COLOR.test(value.color) ||
        typeof value.enabled !== 'boolean'
    ) {
        return false;
    }
    try {
        if (normalizeWaypointName(value.name) !== value.name) return false;
    } catch {
        return false;
    }
    if (!isPosition(value.position)) return false;
    if (value.label !== undefined && !isPlainText(value.label)) return false;
    if (value.description !== undefined && !isPlainText(value.description)) return false;
    if (value.icon !== undefined && (typeof value.icon !== 'string' || !ITEM_ID.test(value.icon))) return false;
    if (
        value.visibilityRange !== undefined &&
        (typeof value.visibilityRange !== 'number' ||
            !Number.isFinite(value.visibilityRange) ||
            value.visibilityRange <= 0 ||
            value.visibilityRange > MAX_VISIBILITY_RANGE)
    ) {
        return false;
    }
    return isAccess(value.access);
}

/** Makes a deep copy of mutable arrays and nested waypoint fields. */
export function cloneWaypoint(waypoint: Waypoint): Waypoint {
    return {
        ...waypoint,
        position: { ...waypoint.position },
        access: { mode: waypoint.access.mode, grants: waypoint.access.grants.map((grant) => ({ ...grant })) },
    };
}

/** Normalizes a user-provided color to canonical uppercase `#RRGGBB`. */
export function normalizeColor(value: string): string {
    if (!COLOR_INPUT.test(value)) throw new TypeError('Waypoint color must be six hexadecimal digits.');
    return `#${value.replace(/^#/, '').toUpperCase()}`;
}

function normalizePosition(value: WaypointPosition): WaypointPosition {
    if (!isRecord(value)) throw new TypeError('Waypoint position must contain x, y, and z.');
    const { x, y, z } = value;
    if (![x, y, z].every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))) {
        throw new RangeError('Waypoint coordinates must be finite.');
    }
    if (Math.abs(x as number) > MAX_HORIZONTAL_COORDINATE || Math.abs(z as number) > MAX_HORIZONTAL_COORDINATE) {
        throw new RangeError(`Waypoint x and z must be within ${MAX_HORIZONTAL_COORDINATE} blocks of the origin.`);
    }
    if (Math.abs(y as number) > MAX_VERTICAL_COORDINATE) {
        throw new RangeError(`Waypoint y must be within ${MAX_VERTICAL_COORDINATE} blocks of 0.`);
    }
    return { x: x as number, y: y as number, z: z as number };
}

function normalizeIcon(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    return normalizeItemIdentifier(value);
}

function normalizeText(value: string | undefined, field: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.trim() === '' || CONTROL.test(value)) {
        throw new TypeError(`Waypoint ${field} must be non-empty plain text without control characters.`);
    }
    return value.trim();
}

function normalizeVisibilityRange(value: number | undefined): number | undefined {
    if (value === undefined) return undefined;
    if (!Number.isFinite(value) || value <= 0 || value > MAX_VISIBILITY_RANGE) {
        throw new RangeError(`Waypoint visibility range must be greater than 0 and at most ${MAX_VISIBILITY_RANGE}.`);
    }
    return value;
}

function normalizeAccess(value: WaypointAccess): WaypointAccess {
    if (!isRecord(value) || (value.mode !== 'restricted' && value.mode !== 'public') || !Array.isArray(value.grants)) {
        throw new TypeError('Waypoint access policy is invalid.');
    }
    const grants = new Map<string, AccessGrant>();
    for (const grant of value.grants) {
        if (!isAccessGrant(grant)) throw new TypeError(invalidGrantMessage(grant));
        grants.set(grantKey(grant), { ...grant });
    }
    return { mode: value.mode, grants: [...grants.values()] };
}

function invalidGrantMessage(grant: unknown): string {
    const type = isRecord(grant) ? grant.type : undefined;
    if (type === 'player') return 'Player grants need a player UUID.';
    if (type === 'permission') return 'Permission grants need a node in the form namespace:node.';
    if (type === 'group') {
        return 'Group names need 1 to 64 lowercase letters, digits, hyphens or underscores, starting with a letter or digit.';
    }
    return 'Waypoint access grant is invalid.';
}

function isPosition(value: unknown): value is WaypointPosition {
    if (!isRecord(value) || !hasOnlyKeys(value, ['x', 'y', 'z'])) return false;
    try {
        normalizePosition(value as unknown as WaypointPosition);
        return true;
    } catch {
        return false;
    }
}

function isPlainText(value: unknown): value is string {
    return typeof value === 'string' && value.trim() !== '' && !CONTROL.test(value);
}

function isAccess(value: unknown): value is WaypointAccess {
    if (
        !isRecord(value) ||
        !hasOnlyKeys(value, ['mode', 'grants']) ||
        (value.mode !== 'restricted' && value.mode !== 'public') ||
        !Array.isArray(value.grants) ||
        !value.grants.every(isAccessGrant)
    ) {
        return false;
    }
    const keys = value.grants.map((grant) => grantKey(grant));
    return new Set(keys).size === keys.length;
}

function isAccessGrant(value: unknown): value is AccessGrant {
    if (!isRecord(value)) return false;
    if (value.type === 'player') {
        return (
            hasOnlyKeys(value, ['type', 'playerId']) && typeof value.playerId === 'string' && UUID.test(value.playerId)
        );
    }
    if (value.type === 'permission') {
        return (
            hasOnlyKeys(value, ['type', 'node']) && typeof value.node === 'string' && PERMISSION_NODE.test(value.node)
        );
    }
    return (
        value.type === 'group' &&
        hasOnlyKeys(value, ['type', 'slug']) &&
        typeof value.slug === 'string' &&
        GROUP_SLUG.test(value.slug)
    );
}

/** Identifies a grant for deduplication; player UUIDs compare case-insensitively. */
export function grantKey(grant: AccessGrant): string {
    switch (grant.type) {
        case 'player':
            return `player:${grant.playerId.toLowerCase()}`;
        case 'permission':
            return `permission:${grant.node}`;
        case 'group':
            return `group:${grant.slug}`;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    return Object.keys(value).every((key) => keys.includes(key));
}

const waypointKeys = [
    'id',
    'name',
    'dimension',
    'position',
    'label',
    'description',
    'color',
    'icon',
    'visibilityRange',
    'enabled',
    'access',
] as const;
