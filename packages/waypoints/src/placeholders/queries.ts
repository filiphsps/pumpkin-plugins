import { canAccessWaypoint } from '../waypoints/access.ts';
import { formatDistance, formatOneDecimal } from '../waypoints/format.ts';
import type { Waypoint, WaypointPosition } from '../waypoints/model.ts';
import { waypointNameKey } from '../waypoints/model.ts';
import { projectWaypointsForViewer, type WaypointViewer } from '../waypoints/visibility.ts';
import type { ParsedCatalogQuery, WaypointField } from './definitions.ts';

/** Live viewer facts required by access checks, world selection, and relative direction. */
export interface WaypointQueryViewer extends WaypointViewer {
    readonly yaw: number;
}

const GEOMETRY_FIELDS: ReadonlySet<WaypointField> = new Set([
    'distance',
    'distance_horizontal',
    'distance_formatted',
    'delta_x',
    'delta_y',
    'delta_z',
    'bearing',
    'direction',
    'relative_direction',
]);

const COMPASS_DIRECTIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
const RELATIVE_DIRECTIONS = [
    'front',
    'front_right',
    'right',
    'back_right',
    'back',
    'back_left',
    'left',
    'front_left',
] as const;

/** Returns enabled waypoints that pass the shared ACL policy for this viewer. */
export function selectAccessibleWaypoints(waypoints: readonly Waypoint[], viewer: WaypointQueryViewer): Waypoint[] {
    return waypoints.filter((waypoint) => waypoint.enabled && canAccessWaypoint(waypoint, viewer));
}

/** Selects the nearest accessible same-world waypoint with deterministic UUID tie-breaking. */
export function closestWaypoint(waypoints: readonly Waypoint[], viewer: WaypointQueryViewer): Waypoint | undefined {
    let closest: Waypoint | undefined;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const waypoint of selectAccessibleWaypoints(waypoints, viewer)) {
        if (waypoint.dimension !== viewer.dimension) continue;
        const distance = geometry(viewer.position, waypoint.position).distance;
        if (
            distance < closestDistance ||
            (distance === closestDistance && closest !== undefined && compareIds(waypoint.id, closest.id) < 0)
        ) {
            closest = waypoint;
            closestDistance = distance;
        }
    }
    return closest;
}

/** Selects a 1-based accessible same-world rank after sorting by raw 3D distance and UUID. */
export function nearestWaypoint(
    waypoints: readonly Waypoint[],
    viewer: WaypointQueryViewer,
    rank: number,
): Waypoint | undefined {
    if (!Number.isInteger(rank) || rank < 1 || rank > 100) return undefined;
    const ranked = selectAccessibleWaypoints(waypoints, viewer)
        .filter((waypoint) => waypoint.dimension === viewer.dimension)
        .map((waypoint) => ({ waypoint, distance: geometry(viewer.position, waypoint.position).distance }))
        .sort((left, right) => left.distance - right.distance || compareIds(left.waypoint.id, right.waypoint.id));
    return ranked[rank - 1]?.waypoint;
}

/** Formats one metadata or geometry field for a selected, already-authorized waypoint. */
export function formatWaypointField(
    waypoint: Waypoint,
    field: WaypointField,
    viewer: WaypointQueryViewer,
): string | undefined {
    if (GEOMETRY_FIELDS.has(field) && waypoint.dimension !== viewer.dimension) return undefined;
    switch (field) {
        case 'id':
            return waypoint.id.toLowerCase();
        case 'name':
            return waypoint.name;
        case 'label':
            return waypoint.label ?? waypoint.name;
        case 'description':
            return waypoint.description ?? '';
        case 'world':
            return waypoint.dimension;
        case 'color':
            return waypoint.color.toUpperCase();
        case 'icon':
            return waypoint.icon ?? '';
        case 'x':
            return formatCoordinate(waypoint.position.x);
        case 'y':
            return formatCoordinate(waypoint.position.y);
        case 'z':
            return formatCoordinate(waypoint.position.z);
        case 'distance':
            return formatOneDecimal(geometry(viewer.position, waypoint.position).distance);
        case 'distance_horizontal':
            return formatOneDecimal(geometry(viewer.position, waypoint.position).horizontal);
        case 'distance_formatted':
            return formatDistance(geometry(viewer.position, waypoint.position).distance);
        case 'delta_x':
            return formatOneDecimal(delta(viewer.position.x, waypoint.position.x));
        case 'delta_y':
            return formatOneDecimal(delta(viewer.position.y, waypoint.position.y));
        case 'delta_z':
            return formatOneDecimal(delta(viewer.position.z, waypoint.position.z));
        case 'bearing': {
            const { dx, dz, horizontal } = geometry(viewer.position, waypoint.position);
            return horizontal === 0 ? '' : formatOneDecimal(roundBearing(bearing(dx, dz)));
        }
        case 'direction': {
            const { dx, dy, dz, horizontal } = geometry(viewer.position, waypoint.position);
            return horizontal === 0 ? verticalDirection(dy) : compassDirection(bearing(dx, dz));
        }
        case 'relative_direction': {
            const { dx, dy, dz, horizontal } = geometry(viewer.position, waypoint.position);
            if (horizontal === 0) return verticalDirection(dy);
            if (!Number.isFinite(viewer.yaw)) throw new RangeError('Viewer yaw is nonfinite');
            const forwardBearing = normalizeDegrees(viewer.yaw + 180);
            return relativeDirection(normalizeDegrees(bearing(dx, dz) - forwardBearing));
        }
        default:
            return assertNever(field);
    }
}

/** Resolves an already-validated catalog query using accessible records only. */
export function catalogValue(
    query: ParsedCatalogQuery,
    waypoints: readonly Waypoint[],
    viewer: WaypointQueryViewer,
): string | undefined {
    const accessible = selectAccessibleWaypoints(waypoints, viewer);
    switch (query.name) {
        case 'count':
            return String(accessible.length);
        case 'count_here':
            return String(accessible.filter((waypoint) => waypoint.dimension === viewer.dimension).length);
        case 'count_world':
            return String(accessible.filter((waypoint) => waypoint.dimension === query.world).length);
        case 'public_count':
            return String(accessible.filter((waypoint) => waypoint.access.mode === 'public').length);
        case 'restricted_count':
            return String(accessible.filter((waypoint) => waypoint.access.mode === 'restricted').length);
        case 'visible_count': {
            const visibleCandidates = accessible.filter(
                (waypoint) => waypoint.dimension === viewer.dimension && waypoint.visibilityRange !== undefined,
            );
            // Fail closed on nonfinite distances; the visibility projector would silently filter them out.
            for (const waypoint of visibleCandidates) geometry(viewer.position, waypoint.position);
            return String(projectWaypointsForViewer(accessible, viewer).length);
        }
        case 'nearby_count': {
            let count = 0;
            for (const waypoint of accessible) {
                if (
                    waypoint.dimension === viewer.dimension &&
                    geometry(viewer.position, waypoint.position).distance <= query.radius
                ) {
                    count++;
                }
            }
            return String(count);
        }
        case 'names':
            return displayNames(accessible);
        case 'names_here':
            return displayNames(accessible.filter((waypoint) => waypoint.dimension === viewer.dimension));
        default:
            return assertNever(query);
    }
}

function displayNames(waypoints: readonly Waypoint[]): string {
    return [...waypoints]
        .sort((left, right) => {
            const leftKey = waypointNameKey(left.name);
            const rightKey = waypointNameKey(right.name);
            return compareText(leftKey, rightKey) || compareIds(left.id, right.id);
        })
        .map(({ name }) => name)
        .join(', ');
}

function geometry(from: WaypointPosition, to: WaypointPosition) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const horizontal = Math.hypot(dx, dz);
    const distance = Math.hypot(dx, dy, dz);
    if (![dx, dy, dz, horizontal, distance].every(Number.isFinite)) {
        throw new RangeError('Waypoint geometry is nonfinite');
    }
    return { dx, dy, dz, horizontal, distance };
}

function delta(from: number, to: number): number {
    const result = to - from;
    if (!Number.isFinite(result)) throw new RangeError('Waypoint delta is nonfinite');
    return result;
}

function bearing(dx: number, dz: number): number {
    return normalizeDegrees((Math.atan2(dx, -dz) * 180) / Math.PI);
}

function roundBearing(degrees: number): number {
    const rounded = Math.round(degrees * 10) / 10;
    return rounded === 360 ? 0 : rounded;
}

function compassDirection(degrees: number): (typeof COMPASS_DIRECTIONS)[number] {
    return COMPASS_DIRECTIONS[sector(degrees)];
}

function relativeDirection(degrees: number): (typeof RELATIVE_DIRECTIONS)[number] {
    return RELATIVE_DIRECTIONS[sector(degrees)];
}

function sector(degrees: number): number {
    return Math.floor((degrees + 22.5 + Number.EPSILON * 360) / 45) % 8;
}

function verticalDirection(dy: number): 'UP' | 'DOWN' | 'HERE' {
    if (dy > 0) return 'UP';
    if (dy < 0) return 'DOWN';
    return 'HERE';
}

function normalizeDegrees(degrees: number): number {
    return ((degrees % 360) + 360) % 360;
}

function formatCoordinate(value: number): string {
    return String(value === 0 ? 0 : value);
}

function compareIds(left: string, right: string): number {
    return compareText(left.toLowerCase(), right.toLowerCase());
}

function compareText(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function assertNever(value: never): never {
    throw new Error(`Unhandled waypoint placeholder value: ${String(value)}`);
}
