import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('pumpkin:plugin/uuid@0.1.0', () => ({
    toString: (id: { readonly value: string }) => id.value,
}));

import { withWaypointViewer } from './pumpkin-context.ts';

const playerId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';

function setup(name = 'Alex') {
    const disposed = { player: false, world: false, opManager: false };
    const world = {
        getName: () => 'world_custom',
        [Symbol.dispose]: () => {
            disposed.world = true;
        },
    };
    const player = {
        getId: () => ({ value: playerId }),
        getName: () => name,
        getWorld: () => world,
        getPosition: () => [1.5, 64.25, -8],
        getYaw: () => 135,
        hasPermission: (node: string) => node === 'Waypoints:group.builders',
        [Symbol.dispose]: () => {
            disposed.player = true;
        },
    };
    const opManager = {
        isOp: (id: { readonly value: string }) => id.value === playerId,
        [Symbol.dispose]: () => {
            disposed.opManager = true;
        },
    };
    const server = {
        getPlayerByName: vi.fn((requested: string) => (requested === name ? player : undefined)),
        getOpManager: () => opManager,
    } as unknown as Server;
    return { disposed, opManager, player, server, world };
}

describe('waypoint Pumpkin viewer context', () => {
    beforeEach(() => vi.clearAllMocks());

    it('snapshots live name, UUID, operator, permission, world, feet position, and yaw', () => {
        const { disposed, server } = setup();
        const result = withWaypointViewer(server, 'Alex', (viewer) => ({
            dimension: viewer.dimension,
            hasPermission: viewer.hasPermission?.('Waypoints:group.builders'),
            isOperator: viewer.isOperator,
            playerId: viewer.playerId,
            position: viewer.position,
            yaw: viewer.yaw,
        }));

        expect(result).toEqual({
            dimension: 'world_custom',
            hasPermission: true,
            isOperator: true,
            playerId: playerId.toLowerCase(),
            position: { x: 1.5, y: 64.25, z: -8 },
            yaw: 135,
        });
        expect(disposed).toEqual({ player: true, world: true, opManager: true });
    });

    it('declines offline, missing, and nonexact player names', () => {
        const offline = setup();
        expect(withWaypointViewer(offline.server, '', () => 'resolved')).toBeUndefined();

        const missing = setup();
        expect(withWaypointViewer(missing.server, 'Morgan', () => 'resolved')).toBeUndefined();
        expect(missing.disposed).toEqual({ player: false, world: false, opManager: false });

        const exact = setup('Alex');
        vi.spyOn(exact.server, 'getPlayerByName').mockReturnValue(exact.player as never);
        expect(withWaypointViewer(exact.server, 'alex', () => 'resolved')).toBeUndefined();
        expect(exact.server.getPlayerByName).toHaveBeenCalledWith('alex');
        expect(exact.disposed).toEqual({ player: true, world: false, opManager: false });
    });

    it('disposes acquired resources when reading operator status or resolving the query fails', () => {
        const acquired = setup();
        vi.spyOn(acquired.server, 'getOpManager').mockImplementation(() => {
            throw new Error('operator manager unavailable');
        });
        expect(() => withWaypointViewer(acquired.server, 'Alex', () => 'unused')).toThrow(
            'operator manager unavailable',
        );
        expect(acquired.disposed).toEqual({ player: true, world: true, opManager: false });

        const callbackFailure = setup();
        expect(() =>
            withWaypointViewer(callbackFailure.server, 'Alex', () => {
                throw new Error('query failed');
            }),
        ).toThrow('query failed');
        expect(callbackFailure.disposed).toEqual({ player: true, world: true, opManager: true });
    });

    it('releases remaining resources if one resource disposal throws', () => {
        const resources = setup();
        vi.spyOn(resources.opManager, Symbol.dispose).mockImplementation(() => {
            throw new Error('op manager disposal failed');
        });

        expect(() => withWaypointViewer(resources.server, 'Alex', () => 'resolved')).toThrow(
            'op manager disposal failed',
        );
        expect(resources.disposed).toEqual({ player: true, world: true, opManager: false });
    });
});
