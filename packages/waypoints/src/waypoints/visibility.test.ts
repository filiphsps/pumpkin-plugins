import { describe, expect, it, vi } from 'vitest';
import { createWaypoint } from './model.ts';
import { projectWaypointsForViewer } from './visibility.ts';

const first = createWaypoint({
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Near',
    dimension: 'world',
    position: { x: 3, y: 4, z: 0 },
    visibilityRange: 5,
    access: { mode: 'public', grants: [] },
});
const second = createWaypoint({
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Far',
    dimension: 'world',
    position: { x: 3, y: 4, z: 1 },
    visibilityRange: 5,
    access: { mode: 'public', grants: [] },
});

describe('waypoint viewer projection', () => {
    it('filters disabled, inaccessible, wrong-dimension, and out-of-range records before rendering', () => {
        const disabled = { ...first, id: '33333333-3333-4333-8333-333333333333', enabled: false };
        const otherDimension = { ...first, id: '44444444-4444-4444-8444-444444444444', dimension: 'nether' };
        const restricted = createWaypoint({
            id: '55555555-5555-4555-8555-555555555555',
            name: 'Secret',
            dimension: 'world',
            position: { x: 0, y: 0, z: 0 },
        });

        const visible = projectWaypointsForViewer([first, second, disabled, otherDimension, restricted], {
            playerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            isOperator: false,
            dimension: 'world',
            position: { x: 0, y: 0, z: 0 },
        });

        expect(visible.map(({ name }) => name)).toEqual(['Near']);
    });

    it('includes a waypoint exactly on its 3D visibility boundary', () => {
        const visible = projectWaypointsForViewer([first], {
            playerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            isOperator: false,
            dimension: 'world',
            position: { x: 0, y: 0, z: 0 },
        });
        expect(visible).toEqual([first]);
    });

    it('does not apply visibility range to waypoints without a range limit', () => {
        const unlimited = createWaypoint({
            id: '66666666-6666-4666-8666-666666666666',
            name: 'Unlimited',
            dimension: 'world',
            position: { x: 10_000, y: 0, z: 0 },
            access: { mode: 'public', grants: [] },
        });
        expect(
            projectWaypointsForViewer([unlimited], {
                playerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                isOperator: false,
                dimension: 'world',
                position: { x: 0, y: 0, z: 0 },
            }),
        ).toEqual([unlimited]);
    });

    it('checks permissions only for waypoints in the viewer dimension and range', () => {
        const access = {
            mode: 'restricted' as const,
            grants: [{ type: 'permission' as const, node: 'Waypoints:use' }],
        };
        const farAway = createWaypoint({
            id: '77777777-7777-4777-8777-777777777777',
            name: 'Far away',
            dimension: 'world',
            position: { x: 100, y: 0, z: 0 },
            visibilityRange: 10,
            access,
        });
        const elsewhere = createWaypoint({
            id: '88888888-8888-4888-8888-888888888888',
            name: 'Elsewhere',
            dimension: 'nether',
            position: { x: 0, y: 0, z: 0 },
            access,
        });
        const hasPermission = vi.fn(() => true);

        const visible = projectWaypointsForViewer([farAway, elsewhere], {
            playerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            isOperator: false,
            hasPermission,
            dimension: 'world',
            position: { x: 0, y: 0, z: 0 },
        });

        expect(visible).toEqual([]);
        expect(hasPermission).not.toHaveBeenCalled();
    });
});
