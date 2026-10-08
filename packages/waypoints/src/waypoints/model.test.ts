import { describe, expect, it } from 'vitest';
import { createWaypoint, type NewWaypoint, normalizeWaypointName, waypointNameKey } from './model.ts';

const id = '11111111-1111-4111-8111-111111111111';

describe('waypoint model', () => {
    it('normalizes names and keeps exact finite coordinates with restricted defaults', () => {
        expect(
            createWaypoint({
                id,
                name: '  Cafe\u0301  ',
                dimension: 'world',
                position: { x: -0.125, y: 64.875, z: -16.01 }
            })
        ).toEqual({
            id,
            name: 'Café',
            dimension: 'world',
            position: { x: -0.125, y: 64.875, z: -16.01 },
            color: '#FFFFFF',
            enabled: true,
            access: { mode: 'restricted', grants: [] }
        });
    });

    it('uses Unicode-normalized case-insensitive name keys', () => {
        expect(waypointNameKey(' Café ')).toBe(waypointNameKey('cafe\u0301'));
        expect(normalizeWaypointName('  Home Base  ')).toBe('Home Base');
    });

    it.each(['', '  ', '\n', 'a'.repeat(65), 'bad\u0000name'])('rejects invalid waypoint name %j', (name) => {
        expect(() => normalizeWaypointName(name)).toThrow();
    });

    it.each([
        [{ x: Number.NaN, y: 0, z: 0 }],
        [{ x: 30_000_001, y: 0, z: 0 }],
        [{ x: 0, y: Number.POSITIVE_INFINITY, z: 0 }],
        [{ x: 0, y: 0, z: -30_000_001 }]
    ])('rejects invalid positions %j', (position) => {
        expect(() => createWaypoint({ id, name: 'Home', dimension: 'world', position })).toThrow();
    });

    it('normalizes color and deduplicates typed access grants', () => {
        const waypoint = createWaypoint({
            id,
            name: 'Home',
            dimension: 'world',
            position: { x: 1, y: 2, z: 3 },
            color: 'aabbcc',
            icon: 'minecraft:lodestone',
            label: 'North Gate',
            description: 'The northern entrance',
            visibilityRange: 128,
            access: {
                mode: 'public',
                grants: [
                    { type: 'player', playerId: '22222222-2222-4222-8222-222222222222' },
                    { type: 'player', playerId: '22222222-2222-4222-8222-222222222222' },
                    { type: 'permission', node: 'Waypoints:group.builders' },
                    { type: 'group', slug: 'builders' }
                ]
            }
        });

        expect(waypoint).toMatchObject({
            color: '#AABBCC',
            icon: 'minecraft:lodestone',
            label: 'North Gate',
            description: 'The northern entrance',
            visibilityRange: 128,
            access: {
                mode: 'public',
                grants: [
                    { type: 'player', playerId: '22222222-2222-4222-8222-222222222222' },
                    { type: 'permission', node: 'Waypoints:group.builders' },
                    { type: 'group', slug: 'builders' }
                ]
            }
        });
    });

    it.each([
        [{ color: '#FFF' }],
        [{ icon: 'lodestone' }],
        [{ label: '  ' }],
        [{ description: 'line\nbreak' }],
        [{ visibilityRange: 0 }],
        [{ visibilityRange: 30_000_001 }],
        [{ access: { mode: 'restricted', grants: [{ type: 'player', playerId: 'not-a-uuid' }] } }]
    ])('rejects invalid metadata %j', (metadata) => {
        expect(() =>
            createWaypoint({
                id,
                name: 'Home',
                dimension: 'world',
                position: { x: 1, y: 2, z: 3 },
                ...metadata
            } as NewWaypoint)
        ).toThrow();
    });
});
