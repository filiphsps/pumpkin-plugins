/** The visibility policy stored on a waypoint. */
export type WaypointVisibility = 'private' | 'public' | 'allowlist';

/** Per-waypoint settings for locator outputs. */
export interface WaypointLocatorSettings {
    /** Whether the waypoint is sent to compatible locator bars. */
    readonly enabled: boolean;
    /** Optional RGB tint in canonical `#RRGGBB` form. */
    readonly color?: string;
    /** Optional Java waypoint style resource ID. */
    readonly javaStyleId?: string;
    /** Reserved for a future Bedrock Script API bridge. */
    readonly bedrockTexture?: string;
}

/** A server-owned location with a stable UUID and object-level access policy. */
export interface Waypoint {
    /** Stable UUID used by commands and output adapters. */
    readonly id: string;
    /** Player-visible name. Names may repeat; IDs may not. */
    readonly name: string;
    /** Pumpkin world registry name. */
    readonly dimension: string;
    /** Integer block coordinate. */
    readonly x: number;
    /** Integer block coordinate. */
    readonly y: number;
    /** Integer block coordinate. */
    readonly z: number;
    /** Canonical UUID of the player who owns this waypoint. */
    readonly ownerId: string;
    /** Who can discover and receive this waypoint. */
    readonly visibility: WaypointVisibility;
    /** Canonical UUIDs allowed when visibility is `allowlist`. */
    readonly allowedPlayerIds: readonly string[];
    /** Locator output settings. */
    readonly locatorBar: WaypointLocatorSettings;
}

/** Input required to create a waypoint owned by a player. */
export interface NewWaypoint {
    readonly id: string;
    readonly name: string;
    readonly dimension: string;
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly ownerId: string;
}

/** Creates a private waypoint and floors each coordinate to its containing block. */
export function createWaypoint(input: NewWaypoint): Waypoint {
    const { id, name, dimension, ownerId } = input;
    if (!id || !name.trim() || !dimension || !ownerId)
        throw new TypeError('Waypoint identity fields must not be empty.');
    if (![input.x, input.y, input.z].every(Number.isFinite))
        throw new RangeError('Waypoint coordinates must be finite.');

    return {
        id,
        name: name.trim(),
        dimension,
        x: Math.floor(input.x),
        y: Math.floor(input.y),
        z: Math.floor(input.z),
        ownerId,
        visibility: 'private',
        allowedPlayerIds: [],
        locatorBar: { enabled: false }
    };
}

/** Returns whether a player may discover or receive a waypoint. */
export function canViewWaypoint(waypoint: Waypoint, playerId: string, isOperator = false): boolean {
    if (isOperator || waypoint.ownerId === playerId) return true;
    if (waypoint.visibility === 'public') return true;
    return waypoint.visibility === 'allowlist' && waypoint.allowedPlayerIds.includes(playerId);
}

/** Returns whether a player may change or delete a waypoint. */
export function canManageWaypoint(waypoint: Waypoint, playerId: string, isOperator = false): boolean {
    return isOperator || waypoint.ownerId === playerId;
}
