import type { Player } from 'pumpkin:plugin/player@0.1.0';
import { describe, expect, it, vi } from 'vitest';
import { HeldItemLightLevels } from '../lights/held-items.ts';
import { nearbyItemIds, readHeldLight } from './player-lights.ts';

describe('Player light resource access', () => {
    it('accepts null empty hands and resources without explicit disposal', () => {
        const player = {
            getPosition: () => [0, 64, 0],
            getWorld: () => ({ getId: () => 'overworld' }),
            getItemInHand: () => null
        } as unknown as Player;

        expect(readHeldLight(player, new HeldItemLightLevels({}))).toEqual({
            worldId: 'overworld',
            position: { x: 0, y: 64, z: 0 },
            lightPosition: { x: 0, y: 64, z: 0 },
            level: 0
        });
    });

    it('releases the main hand and world if acquiring the offhand fails', () => {
        const right = { [Symbol.dispose]: vi.fn() };
        const world = { [Symbol.dispose]: vi.fn() };
        const player = {
            getPosition: () => [0, 64, 0],
            getWorld: () => world,
            getItemInHand: (hand: string) => {
                if (hand === 'right') return right;
                throw new Error('offhand unavailable');
            }
        } as unknown as Player;

        expect(() => readHeldLight(player, undefined)).toThrow('offhand unavailable');
        expect(right[Symbol.dispose]).toHaveBeenCalledOnce();
        expect(world[Symbol.dispose]).toHaveBeenCalledOnce();
    });

    it('releases every nearby entity when inspecting one of them fails', () => {
        const first = {
            getType: () => {
                throw new Error('entity removed');
            },
            [Symbol.dispose]: vi.fn()
        };
        const second = { [Symbol.dispose]: vi.fn() };
        const self = { getNearbyEntities: () => [first, second], [Symbol.dispose]: vi.fn() };
        const player = { asEntity: () => self } as unknown as Player;

        expect(() => nearbyItemIds(player)).toThrow('entity removed');
        for (const resource of [first, second, self]) expect(resource[Symbol.dispose]).toHaveBeenCalledOnce();
    });
});
