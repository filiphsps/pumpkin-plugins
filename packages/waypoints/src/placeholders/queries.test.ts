import { describe, expect, it } from 'vitest';
import { createWaypoint, type NewWaypoint, type Waypoint } from '../waypoints/model.ts';
import type { ParsedCatalogQuery } from './definitions.ts';
import {
    catalogValue,
    closestWaypoint,
    formatWaypointField,
    nearestWaypoint,
    selectAccessibleWaypoints,
    type WaypointQueryViewer,
} from './queries.ts';

const viewerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ids = {
    one: '11111111-1111-4111-8111-111111111111',
    two: '22222222-2222-4222-8222-222222222222',
    three: '33333333-3333-4333-8333-333333333333',
    four: '44444444-4444-4444-8444-444444444444',
};

function waypoint(
    id: string,
    name: string,
    position: Waypoint['position'],
    overrides: Partial<NewWaypoint> = {},
): Waypoint {
    return createWaypoint({
        id,
        name,
        dimension: 'world',
        position,
        access: { mode: 'public', grants: [] },
        ...overrides,
    });
}

function context(overrides: Partial<WaypointQueryViewer> = {}): WaypointQueryViewer {
    return {
        dimension: 'world',
        isOperator: false,
        playerId: viewerId,
        position: { x: 0, y: 64, z: 0 },
        yaw: 0,
        hasPermission: () => false,
        ...overrides,
    };
}

describe('waypoint placeholder queries', () => {
    it('includes only enabled records the live viewer can access', () => {
        const waypoints = [
            waypoint(ids.one, 'Public', { x: 0, y: 64, z: 0 }, { access: { mode: 'public', grants: [] } }),
            waypoint(
                ids.two,
                'Direct',
                { x: 0, y: 64, z: 0 },
                {
                    access: { mode: 'restricted', grants: [{ type: 'player', playerId: viewerId }] },
                },
            ),
            waypoint(
                ids.three,
                'Permission',
                { x: 0, y: 64, z: 0 },
                {
                    access: { mode: 'restricted', grants: [{ type: 'permission', node: 'Waypoints:build' }] },
                },
            ),
            waypoint(
                ids.four,
                'Disabled',
                { x: 0, y: 64, z: 0 },
                {
                    enabled: false,
                    access: { mode: 'public', grants: [] },
                },
            ),
        ];
        const permitted = context({ hasPermission: (node) => node === 'Waypoints:build' });

        expect(selectAccessibleWaypoints(waypoints, permitted).map(({ name }) => name)).toEqual([
            'Public',
            'Direct',
            'Permission',
        ]);
    });

    it('applies permission and group grants and the live operator override', () => {
        const permission = waypoint(
            ids.one,
            'Permission',
            { x: 0, y: 64, z: 0 },
            {
                access: { mode: 'restricted', grants: [{ type: 'permission', node: 'Waypoints:build' }] },
            },
        );
        const group = waypoint(
            ids.two,
            'Group',
            { x: 0, y: 64, z: 0 },
            {
                access: { mode: 'restricted', grants: [{ type: 'group', slug: 'builders' }] },
            },
        );
        const denied = waypoint(
            ids.three,
            'Denied',
            { x: 0, y: 64, z: 0 },
            {
                access: { mode: 'restricted', grants: [{ type: 'player', playerId: ids.three }] },
            },
        );

        const granted = context({
            hasPermission: (node) => node === 'Waypoints:build' || node === 'Waypoints:group.builders',
        });
        expect(selectAccessibleWaypoints([permission, group, denied], granted).map(({ name }) => name)).toEqual([
            'Permission',
            'Group',
        ]);
        expect(selectAccessibleWaypoints([permission, group, denied], context({ isOperator: true }))).toEqual([
            permission,
            group,
            denied,
        ]);
    });

    it('selects closest in the exact world by 3D distance and breaks ties by lowercase UUID', () => {
        const waypoints = [
            waypoint(ids.two, 'Tie second', { x: 3, y: 64, z: 4 }, { visibilityRange: 1 }),
            waypoint(ids.one, 'Tie first', { x: 0, y: 64, z: 5 }),
            waypoint(
                ids.three,
                'Other world',
                { x: 0, y: 64, z: 0 },
                {
                    dimension: 'World',
                    access: { mode: 'public', grants: [] },
                },
            ),
            waypoint(
                ids.four,
                'Closer-looking Nether',
                { x: 0, y: 64, z: 0 },
                {
                    dimension: 'minecraft:the_nether',
                    access: { mode: 'public', grants: [] },
                },
            ),
        ];

        expect(closestWaypoint(waypoints, context())?.id).toBe(ids.one);
    });

    it('ranks all accessible same-world candidates by full distance before formatting', () => {
        const waypoints = [
            waypoint(ids.three, 'Third', { x: 0, y: 64, z: 5 }),
            waypoint(ids.two, 'Second', { x: 0, y: 70, z: 0 }),
            waypoint(ids.one, 'First', { x: 0, y: 64, z: 5 }),
            waypoint(
                ids.four,
                'Denied',
                { x: 0, y: 64, z: 1 },
                {
                    access: { mode: 'restricted', grants: [{ type: 'player', playerId: ids.four }] },
                },
            ),
        ];

        expect(nearestWaypoint(waypoints, context(), 1)?.id).toBe(ids.one);
        expect(nearestWaypoint(waypoints, context(), 2)?.id).toBe(ids.three);
        expect(nearestWaypoint(waypoints, context(), 3)?.id).toBe(ids.two);
        expect(nearestWaypoint(waypoints, context(), 100)).toBeUndefined();
    });

    it('returns literal catalog counts, HUD visibility, radius boundaries, and sorted display names', () => {
        const waypoints = [
            waypoint(
                ids.two,
                'bravo',
                { x: 3, y: 64, z: 4 },
                {
                    visibilityRange: 5,
                    access: { mode: 'public', grants: [] },
                },
            ),
            waypoint(
                ids.one,
                'Alpha',
                { x: 0, y: 64, z: 0 },
                {
                    access: { mode: 'restricted', grants: [{ type: 'player', playerId: viewerId }] },
                },
            ),
            waypoint(
                ids.three,
                'Elsewhere',
                { x: 0, y: 64, z: 0 },
                {
                    dimension: 'world_nether',
                    access: { mode: 'public', grants: [] },
                },
            ),
            waypoint(
                ids.four,
                'Denied',
                { x: 0, y: 64, z: 0 },
                {
                    access: { mode: 'restricted', grants: [{ type: 'player', playerId: ids.four }] },
                },
            ),
        ];
        const viewer = context();
        const value = (query: ParsedCatalogQuery) => catalogValue(query, waypoints, viewer);

        expect(value({ name: 'count' })).toBe('3');
        expect(value({ name: 'count_here' })).toBe('2');
        expect(value({ name: 'count_world', world: 'world_nether' })).toBe('1');
        expect(value({ name: 'public_count' })).toBe('2');
        expect(value({ name: 'restricted_count' })).toBe('1');
        expect(value({ name: 'visible_count' })).toBe('2');
        expect(value({ name: 'nearby_count', radius: 5 })).toBe('2');
        expect(value({ name: 'names' })).toBe('Alpha, bravo, Elsewhere');
        expect(value({ name: 'names_here' })).toBe('Alpha, bravo');
    });

    it('formats metadata, distance, deltas, and directions from feet position', () => {
        const destination = waypoint(
            ids.one,
            'Home',
            { x: 0, y: 64, z: -1 },
            {
                label: 'My home',
                description: 'Safe place',
                color: '#12abef',
                icon: 'minecraft:oak_door',
                access: { mode: 'public', grants: [] },
            },
        );
        const viewer = context({ yaw: 0 });

        expect(formatWaypointField(destination, 'id', viewer)).toBe(ids.one);
        expect(formatWaypointField(destination, 'name', viewer)).toBe('Home');
        expect(formatWaypointField(destination, 'label', viewer)).toBe('My home');
        expect(formatWaypointField(destination, 'world', viewer)).toBe('world');
        expect(formatWaypointField(destination, 'color', viewer)).toBe('#12ABEF');
        expect(formatWaypointField(destination, 'icon', viewer)).toBe('minecraft:oak_door');
        expect(formatWaypointField(destination, 'x', viewer)).toBe('0');
        expect(formatWaypointField(destination, 'distance', viewer)).toBe('1.0');
        expect(formatWaypointField(destination, 'distance_horizontal', viewer)).toBe('1.0');
        expect(formatWaypointField(destination, 'distance_formatted', viewer)).toBe('1m');
        expect(formatWaypointField(destination, 'delta_z', viewer)).toBe('-1.0');
        expect(formatWaypointField(destination, 'bearing', viewer)).toBe('0.0');
        expect(formatWaypointField(destination, 'direction', viewer)).toBe('N');
        expect(formatWaypointField(destination, 'relative_direction', viewer)).toBe('back');
    });

    it('uses clockwise compass sectors and Minecraft south-facing yaw for all relative sectors', () => {
        const viewer = context({ yaw: 0 });
        const compassCases = [
            [0, 'N', 'back'],
            [45, 'NE', 'back_left'],
            [90, 'E', 'left'],
            [135, 'SE', 'front_left'],
            [180, 'S', 'front'],
            [225, 'SW', 'front_right'],
            [270, 'W', 'right'],
            [315, 'NW', 'back_right'],
        ] as const;

        for (const [bearing, direction, relative] of compassCases) {
            const radians = (bearing * Math.PI) / 180;
            const destination = waypoint(ids.one, `Bearing ${bearing}`, {
                x: Math.sin(radians),
                y: 64,
                z: -Math.cos(radians),
            });
            expect(formatWaypointField(destination, 'direction', viewer), `${bearing} degrees`).toBe(direction);
            expect(formatWaypointField(destination, 'relative_direction', viewer), `${bearing} degrees`).toBe(relative);
        }

        const north = waypoint(ids.two, 'North', { x: 0, y: 64, z: -1 });
        expect(formatWaypointField(north, 'relative_direction', context({ yaw: 180 }))).toBe('front');
        expect(formatWaypointField(north, 'relative_direction', context({ yaw: -180 }))).toBe('front');
        expect(formatWaypointField(north, 'relative_direction', context({ yaw: 540 }))).toBe('front');
    });

    it('assigns exact compass-sector boundaries clockwise and wraps a rounded bearing below 360', () => {
        const viewer = context();
        const boundaries = [
            [22.499, 'N'],
            [22.5, 'NE'],
            [67.5, 'E'],
            [112.5, 'SE'],
            [157.5, 'S'],
            [202.5, 'SW'],
            [247.5, 'W'],
            [292.5, 'NW'],
            [337.5, 'N'],
        ] as const;

        for (const [bearing, expected] of boundaries) {
            const radians = (bearing * Math.PI) / 180;
            const destination = waypoint(ids.one, `Boundary ${bearing}`, {
                x: Math.sin(radians),
                y: 64,
                z: -Math.cos(radians),
            });
            expect(formatWaypointField(destination, 'direction', viewer), `${bearing} degrees`).toBe(expected);
        }

        const justWestOfNorth = waypoint(ids.two, 'Rounding wrap', {
            x: -0.0007,
            y: 64,
            z: -1,
        });
        expect(formatWaypointField(justWestOfNorth, 'bearing', viewer)).toBe('0.0');
    });

    it('normalizes negative zero and keeps name-order UUID ties lexical', () => {
        const negativeZero = waypoint(ids.one, 'Zero', { x: -0, y: 64, z: 0 });
        const first = waypoint(ids.one, 'home', { x: 0, y: 64, z: 0 });
        const second = waypoint(ids.two, 'Home', { x: 0, y: 64, z: 0 });

        expect(formatWaypointField(negativeZero, 'x', context())).toBe('0');
        expect(catalogValue({ name: 'names' }, [second, first], context())).toBe('home, Home');
    });

    it('returns empty optional metadata and handles vertical or coincident directions', () => {
        const destination = waypoint(ids.one, 'Same spot', { x: 0, y: 64, z: 0 });
        const above = waypoint(ids.two, 'Above', { x: 0, y: 70, z: 0 });
        const below = waypoint(ids.three, 'Below', { x: 0, y: 60, z: 0 });
        const viewer = context();

        expect(formatWaypointField(destination, 'description', viewer)).toBe('');
        expect(formatWaypointField(destination, 'label', viewer)).toBe('Same spot');
        expect(formatWaypointField(destination, 'icon', viewer)).toBe('');
        expect(formatWaypointField(destination, 'bearing', viewer)).toBe('');
        expect(formatWaypointField(destination, 'direction', viewer)).toBe('HERE');
        expect(formatWaypointField(destination, 'relative_direction', viewer)).toBe('HERE');
        expect(formatWaypointField(above, 'direction', viewer)).toBe('UP');
        expect(formatWaypointField(above, 'relative_direction', viewer)).toBe('UP');
        expect(formatWaypointField(below, 'direction', viewer)).toBe('DOWN');
        expect(formatWaypointField(below, 'relative_direction', viewer)).toBe('DOWN');
    });

    it('declines geometry for an authorized waypoint in another world', () => {
        const destination = waypoint(
            ids.one,
            'Elsewhere',
            { x: 10, y: 64, z: 20 },
            {
                dimension: 'world_nether',
                access: { mode: 'public', grants: [] },
            },
        );

        expect(formatWaypointField(destination, 'name', context())).toBe('Elsewhere');
        expect(formatWaypointField(destination, 'distance', context())).toBeUndefined();
        expect(formatWaypointField(destination, 'direction', context())).toBeUndefined();
    });

    it('switches to kilometers once the distance rounds to 1000 meters, like the HUD', () => {
        const meters = waypoint(ids.one, 'Meters', { x: 999.4, y: 64, z: 0 });
        const kilometers = waypoint(ids.two, 'Kilometers', { x: 999.5, y: 64, z: 0 });

        expect(formatWaypointField(meters, 'distance_formatted', context())).toBe('999m');
        expect(formatWaypointField(kilometers, 'distance_formatted', context())).toBe('1.0km');
    });

    it('rejects partial selection when geometry becomes nonfinite', () => {
        const extreme = waypoint(ids.one, 'Extreme', { x: 0, y: 20_000_000, z: 0 });
        const farViewer = context({ position: { x: -Number.MAX_VALUE, y: -Number.MAX_VALUE, z: 0 } });

        expect(() => closestWaypoint([extreme], farViewer)).toThrow(RangeError);
        expect(() => formatWaypointField(extreme, 'distance', farViewer)).toThrow(RangeError);
    });
});
