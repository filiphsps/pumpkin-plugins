/** Description and output shape for one waypoint metadata field. */
export interface FieldDefinition {
    readonly description: string;
    readonly output: string;
}

/** Description and optional argument kind for a catalog placeholder. */
export interface CatalogDefinition {
    readonly argument?: 'radius' | 'world';
    readonly description: string;
}

/** One advertised PIE identifier and the argument expected by its token family. */
export interface PlaceholderDefinition {
    readonly argument?: 'rank' | 'radius' | 'uuid' | 'world';
    readonly description: string;
    readonly name: PlaceholderName;
}

/** Output contracts shared by closest, nearest, and explicit waypoint lookups. */
export const waypointFields = {
    id: { description: 'Canonical waypoint UUID.', output: 'canonical lowercase UUID' },
    name: { description: 'Complete saved waypoint name.', output: 'text' },
    label: { description: 'Saved display label, falling back to the name.', output: 'text' },
    description: { description: 'Saved description, or an empty string.', output: 'text' },
    world: { description: 'Exact saved world key.', output: 'text' },
    color: { description: 'Canonical waypoint color.', output: 'uppercase #RRGGBB' },
    icon: { description: 'Canonical item ID, or an empty string.', output: 'item ID or empty' },
    x: { description: 'Saved X coordinate.', output: 'locale-independent number; negative zero is 0' },
    y: { description: 'Saved Y coordinate.', output: 'locale-independent number; negative zero is 0' },
    z: { description: 'Saved Z coordinate.', output: 'locale-independent number; negative zero is 0' },
    distance: { description: 'Raw three-dimensional distance.', output: 'blocks to one decimal, no suffix' },
    distance_horizontal: { description: 'Raw X/Z distance.', output: 'blocks to one decimal, no suffix' },
    distance_formatted: {
        description: 'Human-readable distance.',
        output: 'whole meters while it rounds below 1000; otherwise kilometers to one decimal',
    },
    delta_x: { description: 'Destination X minus viewer X.', output: 'blocks to one decimal' },
    delta_y: { description: 'Destination Y minus viewer Y.', output: 'blocks to one decimal' },
    delta_z: { description: 'Destination Z minus viewer Z.', output: 'blocks to one decimal' },
    bearing: { description: 'Horizontal compass bearing, north at zero.', output: 'degrees to one decimal' },
    direction: {
        description: 'Eight-point compass direction.',
        output: 'N, NE, E, SE, S, SW, W, NW, UP, DOWN, or HERE',
    },
    relative_direction: {
        description: 'Eight-point direction relative to the viewer yaw.',
        output: 'front, front_right, right, back_right, back, back_left, left, front_left, UP, DOWN, or HERE',
    },
} as const satisfies Record<string, FieldDefinition>;

/** Accessible waypoint catalog values that do not need a selected destination. */
export const catalogPlaceholders = {
    count: { description: 'Accessible enabled waypoint count across all worlds.' },
    count_here: { description: 'Accessible enabled waypoint count in the current world.' },
    count_world: { argument: 'world', description: 'Accessible enabled waypoint count in the exact argument world.' },
    public_count: { description: 'Accessible public-record count across all worlds.' },
    restricted_count: { description: 'Accessible restricted-record count across all worlds.' },
    visible_count: { description: 'Same-world count eligible for the HUD visibility range.' },
    nearby_count: { argument: 'radius', description: 'Same-world count within the 3D radius in blocks.' },
    names: { description: 'Accessible waypoint names across worlds, joined by comma and space.' },
    names_here: { description: 'Accessible same-world waypoint names, joined by comma and space.' },
} as const satisfies Record<string, CatalogDefinition>;

/** Existence lookups use the same privacy rules as their metadata families. */
export const existsPlaceholders = {
    closest_exists: { description: 'Whether an accessible same-world closest waypoint exists.' },
    nearest_exists: { argument: 'rank', description: 'Whether the requested accessible same-world rank exists.' },
    waypoint_exists: { argument: 'uuid', description: 'Whether the enabled UUID is accessible to the viewer.' },
} as const satisfies Record<string, Omit<PlaceholderDefinition, 'name'>>;

/** The metadata fields implemented by every waypoint family. */
export type WaypointField = keyof typeof waypointFields;
/** A field lookup identifier generated for each destination-selection family. */
export type FieldPlaceholderName =
    | `closest_${WaypointField}`
    | `nearest_${WaypointField}`
    | `waypoint_${WaypointField}`;
/** A catalog lookup identifier. */
export type CatalogPlaceholderName = keyof typeof catalogPlaceholders;
/** An existence lookup identifier. */
export type ExistsPlaceholderName = keyof typeof existsPlaceholders;
/** Every local placeholder name registered under the `waypoints` namespace. */
export type PlaceholderName = FieldPlaceholderName | CatalogPlaceholderName | ExistsPlaceholderName;

/** A validated catalog query with its argument narrowed by identifier. */
export type ParsedCatalogQuery =
    | {
          readonly name:
              | 'count'
              | 'count_here'
              | 'public_count'
              | 'restricted_count'
              | 'visible_count'
              | 'names'
              | 'names_here';
      }
    | { readonly name: 'count_world'; readonly world: string }
    | { readonly name: 'nearby_count'; readonly radius: number };

/** A validated query ready for pure selection or catalog evaluation. */
export type ParsedQuery =
    | { readonly kind: 'closest'; readonly field: WaypointField | 'exists' }
    | { readonly kind: 'nearest'; readonly field: WaypointField | 'exists'; readonly rank: number }
    | { readonly kind: 'waypoint'; readonly field: WaypointField | 'exists'; readonly id: string }
    | ({ readonly kind: 'catalog' } & ParsedCatalogQuery);

/** All advertised names and descriptions, generated from the contract tables above. */
export const waypointPlaceholderDefinitions: readonly PlaceholderDefinition[] = [
    ...Object.entries(catalogPlaceholders).map(([name, definition]) => ({
        name: name as CatalogPlaceholderName,
        ...definition,
    })),
    ...Object.entries(existsPlaceholders).map(([name, definition]) => ({
        name: name as ExistsPlaceholderName,
        ...definition,
    })),
    ...Object.entries(waypointFields).flatMap(([field, definition]) => {
        const fieldName = field as WaypointField;
        const description = definition.description.replace(/\.$/, '');
        return [
            {
                name: `closest_${fieldName}` as FieldPlaceholderName,
                description: `${description} (closest accessible same-world waypoint).`,
            },
            {
                name: `nearest_${fieldName}` as FieldPlaceholderName,
                argument: 'rank' as const,
                description: `${description} (requested accessible same-world rank).`,
            },
            {
                name: `waypoint_${fieldName}` as FieldPlaceholderName,
                argument: 'uuid' as const,
                description: `${description} (accessible waypoint UUID argument).`,
            },
        ];
    }),
];

/** Identifiers advertised to PumpkinPIE, without the namespace prefix. */
export const waypointPlaceholderNames: readonly PlaceholderName[] = waypointPlaceholderDefinitions.map(
    ({ name }) => name,
);
