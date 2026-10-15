import { LIMITS } from '@pumpkin-plugins/pumpkin-pie-api';
import { strToU8 } from 'fflate';
import { canAccessWaypoint } from '../waypoints/access.ts';
import { isWaypointId, type Waypoint } from '../waypoints/model.ts';
import {
    catalogPlaceholders,
    type ParsedCatalogQuery,
    type ParsedQuery,
    type WaypointField,
    waypointFields,
} from './definitions.ts';
import {
    catalogValue,
    closestWaypoint,
    formatWaypointField,
    nearestWaypoint,
    type WaypointQueryViewer,
} from './queries.ts';

/** Read-only access to the live waypoint catalog used for each provider callback. */
export interface WaypointCatalogReader {
    getById(id: string): Waypoint | undefined;
    readonly isAvailable: boolean;
    list(): Waypoint[];
}

/** Bounded reason codes emitted when a valid query cannot be evaluated safely. */
export type PlaceholderFailure = 'query_failed' | 'value_too_large';

/** Parses one local identifier and rejects malformed or unexpected arguments. */
export function parsePlaceholder(name: string, argument?: string): ParsedQuery | undefined {
    if (isCatalogName(name)) {
        const query = parseCatalogQuery(name, argument);
        return query === undefined ? undefined : { kind: 'catalog', ...query };
    }

    if (name === 'closest_exists') {
        return argument === undefined ? { kind: 'closest', field: 'exists' } : undefined;
    }
    if (name === 'nearest_exists') {
        const rank = parseRank(argument);
        return rank === undefined ? undefined : { kind: 'nearest', field: 'exists', rank };
    }
    if (name === 'waypoint_exists') {
        const id = parseWaypointId(argument);
        return id === undefined ? undefined : { kind: 'waypoint', field: 'exists', id };
    }

    const separator = name.indexOf('_');
    if (separator < 0) return undefined;
    const family = name.slice(0, separator);
    const fieldName = name.slice(separator + 1);
    if (!isWaypointField(fieldName)) return undefined;

    switch (family) {
        case 'closest':
            return argument === undefined ? { kind: 'closest', field: fieldName } : undefined;
        case 'nearest': {
            const rank = parseRank(argument);
            return rank === undefined ? undefined : { kind: 'nearest', field: fieldName, rank };
        }
        case 'waypoint': {
            const id = parseWaypointId(argument);
            return id === undefined ? undefined : { kind: 'waypoint', field: fieldName, id };
        }
        default:
            return undefined;
    }
}

/** Resolves one parsed PIE name against the current catalog and viewer state. */
export function resolvePlaceholder(
    name: string,
    argument: string | undefined,
    catalog: WaypointCatalogReader,
    viewer: WaypointQueryViewer | undefined,
    onFailure?: (identifier: string, reason: PlaceholderFailure) => void,
): string | undefined {
    const query = parsePlaceholder(name, argument);
    if (query === undefined || viewer === undefined) return undefined;

    try {
        if (!catalog.isAvailable) {
            reportFailure(onFailure, name, 'query_failed');
            return undefined;
        }
        const value = resolveQuery(query, catalog, viewer);
        if (value !== undefined && strToU8(value).length > LIMITS.text) {
            reportFailure(onFailure, name, 'value_too_large');
            return undefined;
        }
        return value;
    } catch {
        reportFailure(onFailure, name, 'query_failed');
        return undefined;
    }
}

function resolveQuery(
    query: ParsedQuery,
    catalog: WaypointCatalogReader,
    viewer: WaypointQueryViewer,
): string | undefined {
    if (query.kind === 'catalog') return catalogValue(query, catalog.list(), viewer);

    if (query.kind === 'waypoint') {
        const waypoint = catalog.getById(query.id);
        if (waypoint === undefined || !waypoint.enabled || !canAccessWaypoint(waypoint, viewer)) {
            return query.field === 'exists' ? 'false' : undefined;
        }
        return query.field === 'exists' ? 'true' : formatWaypointField(waypoint, query.field, viewer);
    }

    const waypoint =
        query.kind === 'closest'
            ? closestWaypoint(catalog.list(), viewer)
            : nearestWaypoint(catalog.list(), viewer, query.rank);
    if (waypoint === undefined) return query.field === 'exists' ? 'false' : '';
    return query.field === 'exists' ? 'true' : formatWaypointField(waypoint, query.field, viewer);
}

function parseCatalogQuery(name: keyof typeof catalogPlaceholders, argument?: string): ParsedCatalogQuery | undefined {
    switch (name) {
        case 'count_world':
            return argument !== undefined && argument.length > 0 && strToU8(argument).length <= LIMITS.id
                ? { name, world: argument }
                : undefined;
        case 'nearby_count': {
            const radius = parseRadius(argument);
            return radius === undefined ? undefined : { name, radius };
        }
        default:
            return argument === undefined ? { name } : undefined;
    }
}

function parseRank(argument: string | undefined): number | undefined {
    if (argument === undefined || !/^\d+$/.test(argument)) return undefined;
    const rank = Number(argument);
    return Number.isSafeInteger(rank) && rank >= 1 && rank <= 100 ? rank : undefined;
}

function parseRadius(argument: string | undefined): number | undefined {
    if (argument === undefined || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(argument)) return undefined;
    const radius = Number(argument);
    return Number.isFinite(radius) && radius > 0 && radius <= 30_000_000 ? radius : undefined;
}

function parseWaypointId(argument: string | undefined): string | undefined {
    return argument !== undefined && isWaypointId(argument) ? argument.toLowerCase() : undefined;
}

function isCatalogName(name: string): name is keyof typeof catalogPlaceholders {
    return Object.hasOwn(catalogPlaceholders, name);
}

function isWaypointField(value: string): value is WaypointField {
    return Object.hasOwn(waypointFields, value);
}

function reportFailure(
    onFailure: ((identifier: string, reason: PlaceholderFailure) => void) | undefined,
    name: string,
    reason: PlaceholderFailure,
): void {
    try {
        onFailure?.(name.slice(0, LIMITS.id), reason);
    } catch {
        // Diagnostics must never turn a declined placeholder into a provider callback failure.
    }
}
