import { describe, expect, it, vi } from 'vitest';
import { canAccessWaypoint } from './access.ts';
import { createWaypoint } from './model.ts';

const waypointId = '11111111-1111-4111-8111-111111111111';
const visitorId = '22222222-2222-4222-8222-222222222222';

const base = createWaypoint({
    id: waypointId,
    name: 'Home',
    dimension: 'world',
    position: { x: 1, y: 64, z: 2 }
});

describe('waypoint access', () => {
    it('allows operators to bypass restricted access and keeps regular users denied by default', () => {
        expect(canAccessWaypoint(base, { playerId: visitorId, isOperator: false })).toBe(false);
        expect(canAccessWaypoint(base, { playerId: visitorId, isOperator: true })).toBe(true);
    });

    it('allows public mode to all non-operators without a permission provider', () => {
        const waypoint = { ...base, access: { mode: 'public' as const, grants: [] } };
        expect(canAccessWaypoint(waypoint, { playerId: visitorId, isOperator: false })).toBe(true);
    });

    it('evaluates player, exact permission, and group-marker grants additively', () => {
        const hasPermission = vi.fn((node: string) => node === 'Waypoints:group.builders');
        const waypoint = {
            ...base,
            access: {
                mode: 'restricted' as const,
                grants: [
                    { type: 'player' as const, playerId: visitorId },
                    { type: 'permission' as const, node: 'Waypoints:build' },
                    { type: 'group' as const, slug: 'builders' }
                ]
            }
        };

        expect(canAccessWaypoint(waypoint, { playerId: visitorId.toUpperCase(), isOperator: false })).toBe(true);
        expect(
            canAccessWaypoint(waypoint, {
                playerId: '33333333-3333-4333-8333-333333333333',
                isOperator: false,
                hasPermission: () => true
            })
        ).toBe(true);
        expect(
            canAccessWaypoint(waypoint, {
                playerId: '44444444-4444-4444-8444-444444444444',
                isOperator: false,
                hasPermission
            })
        ).toBe(true);
        expect(hasPermission).toHaveBeenCalledWith('Waypoints:build');
        expect(hasPermission).toHaveBeenCalledWith('Waypoints:group.builders');
    });

    it('does not let a missing or disabled access grant leak through', () => {
        const hasPermission = vi.fn(() => false);
        const waypoint = {
            ...base,
            access: { mode: 'restricted' as const, grants: [{ type: 'permission' as const, node: 'Waypoints:use' }] }
        };
        expect(canAccessWaypoint(waypoint, { playerId: visitorId, isOperator: false, hasPermission })).toBe(false);
        expect(hasPermission).toHaveBeenCalledWith('Waypoints:use');
    });
});
