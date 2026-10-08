import { describe, expect, it } from 'vitest';
import { canManageWaypoint, canViewWaypoint, createWaypoint } from './model.ts';

const id = '11111111-1111-4111-8111-111111111111';
const owner = '22222222-2222-4222-8222-222222222222';
const visitor = '33333333-3333-4333-8333-333333333333';

describe('waypoint model', () => {
    it('floors block coordinates and defaults to private with locator output disabled', () => {
        const waypoint = createWaypoint({
            id,
            name: 'Home',
            dimension: 'minecraft:overworld',
            x: -0.1,
            y: 64.9,
            z: -16.01,
            ownerId: owner
        });

        expect(waypoint).toMatchObject({
            x: -1,
            y: 64,
            z: -17,
            visibility: 'private',
            allowedPlayerIds: [],
            locatorBar: { enabled: false }
        });
    });

    it('allows owners and operators to view private points', () => {
        const waypoint = createWaypoint({
            id,
            name: 'Home',
            dimension: 'minecraft:overworld',
            x: 0,
            y: 0,
            z: 0,
            ownerId: owner
        });

        expect(canViewWaypoint(waypoint, owner)).toBe(true);
        expect(canViewWaypoint(waypoint, visitor)).toBe(false);
        expect(canViewWaypoint(waypoint, visitor, true)).toBe(true);
    });

    it('lets allowlisted players view but not manage a point', () => {
        const waypoint = {
            ...createWaypoint({ id, name: 'Home', dimension: 'minecraft:overworld', x: 0, y: 0, z: 0, ownerId: owner }),
            visibility: 'allowlist' as const,
            allowedPlayerIds: [visitor]
        };

        expect(canViewWaypoint(waypoint, visitor)).toBe(true);
        expect(canManageWaypoint(waypoint, visitor)).toBe(false);
        expect(canManageWaypoint(waypoint, visitor, true)).toBe(true);
    });

    it('makes public points visible to everyone while keeping mutations owner-scoped', () => {
        const waypoint = {
            ...createWaypoint({ id, name: 'Home', dimension: 'minecraft:overworld', x: 0, y: 0, z: 0, ownerId: owner }),
            visibility: 'public' as const
        };

        expect(canViewWaypoint(waypoint, visitor)).toBe(true);
        expect(canManageWaypoint(waypoint, visitor)).toBe(false);
        expect(canManageWaypoint(waypoint, owner)).toBe(true);
    });
});
