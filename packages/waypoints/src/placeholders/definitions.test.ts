import { describe, expect, it } from 'vitest';
import { waypointFields, waypointPlaceholderNames } from './definitions.ts';

type ExpectedField =
    | 'id'
    | 'name'
    | 'label'
    | 'description'
    | 'world'
    | 'color'
    | 'icon'
    | 'x'
    | 'y'
    | 'z'
    | 'distance'
    | 'distance_horizontal'
    | 'distance_formatted'
    | 'delta_x'
    | 'delta_y'
    | 'delta_z'
    | 'bearing'
    | 'direction'
    | 'relative_direction';
type ExpectedPlaceholderName =
    | 'count'
    | 'count_here'
    | 'count_world'
    | 'public_count'
    | 'restricted_count'
    | 'visible_count'
    | 'nearby_count'
    | 'names'
    | 'names_here'
    | 'closest_exists'
    | 'nearest_exists'
    | 'waypoint_exists'
    | `closest_${ExpectedField}`
    | `nearest_${ExpectedField}`
    | `waypoint_${ExpectedField}`;

const expectedFields: ExpectedField[] = [
    'id',
    'name',
    'label',
    'description',
    'world',
    'color',
    'icon',
    'x',
    'y',
    'z',
    'distance',
    'distance_horizontal',
    'distance_formatted',
    'delta_x',
    'delta_y',
    'delta_z',
    'bearing',
    'direction',
    'relative_direction',
];
const expectedNames: ExpectedPlaceholderName[] = [
    'count',
    'count_here',
    'count_world',
    'public_count',
    'restricted_count',
    'visible_count',
    'nearby_count',
    'names',
    'names_here',
    'closest_exists',
    'nearest_exists',
    'waypoint_exists',
    ...expectedFields.flatMap((field) => [`closest_${field}`, `nearest_${field}`, `waypoint_${field}`] as const),
];

describe('waypoint placeholder definitions', () => {
    it('advertises every catalog, existence, and field-family identifier exactly once', () => {
        expect(Object.keys(waypointFields)).toEqual(expectedFields);
        expect(waypointPlaceholderNames).toEqual(expectedNames);
        expect(new Set(waypointPlaceholderNames).size).toBe(expectedNames.length);
    });
});
