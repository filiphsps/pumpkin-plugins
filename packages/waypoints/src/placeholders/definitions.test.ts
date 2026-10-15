import { describe, expect, it } from 'vitest';
import { type ParsedQuery, type PlaceholderName, waypointFields, waypointPlaceholderNames } from './definitions.ts';

type Equal<Left, Right> =
    (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Expect<Value extends true> = Value;

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

type FieldTableCoversTheContract = Expect<Equal<keyof typeof waypointFields, ExpectedField>>;
type PlaceholderTypesCoverTheContract = Expect<Equal<PlaceholderName, ExpectedPlaceholderName>>;
const typeCoverage: [FieldTableCoversTheContract, PlaceholderTypesCoverTheContract] = [true, true];
void typeCoverage;

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

    it('keeps parsed query shapes narrow', () => {
        const closest = { kind: 'closest', field: 'distance' } satisfies ParsedQuery;
        const nearest = { kind: 'nearest', field: 'exists', rank: 2 } satisfies ParsedQuery;
        const waypoint = {
            kind: 'waypoint',
            field: 'name',
            id: '11111111-1111-4111-8111-111111111111',
        } satisfies ParsedQuery;
        // @ts-expect-error Unknown fields must not enter the parsed query union.
        const invalid = { kind: 'closest', field: 'owner' } satisfies ParsedQuery;
        expect([closest.kind, nearest.rank, waypoint.id]).toEqual([
            'closest',
            2,
            '11111111-1111-4111-8111-111111111111',
        ]);
        void invalid;
    });
});
