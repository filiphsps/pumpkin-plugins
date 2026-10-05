import { defaultValues } from '@pumpkin-plugins/config';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    lookup: vi.fn(() => ({ name: 'minecraft:stone', properties: [] as [string, string][] }))
}));
vi.mock('pumpkin:plugin/world@0.1.0', () => ({ blockStateToInfo: state.lookup }));

import type { Player } from 'pumpkin:plugin/player@0.1.0';
import { schema } from '../config/schema.ts';
import { withPlayer } from './peers.ts';

describe('Pumpkin terrain adapter', () => {
    it('reads negative coordinates locally and disposes chunk, border, world and client handles', () => {
        const values = defaultValues(schema),
            settings = { ...values.support, worlds: values.worlds };
        const chunk = {
            getBlockStateId: vi.fn(() => 1),
            getBiome: vi.fn(() => 'old-growth-pine-taiga'),
            getTopBlockY: () => 64,
            getSkyLight: () => 15,
            getBlockLight: () => 0,
            [Symbol.dispose]: vi.fn()
        };
        const border = { getCenterX: () => 0, getCenterZ: () => 0, getSize: () => 60000000, [Symbol.dispose]: vi.fn() };
        const world = {
            getName: () => 'world',
            getDimension: () => 'minecraft:overworld',
            getMinY: () => -64,
            getWorldBorder: () => border,
            getChunk: vi.fn(() => chunk),
            [Symbol.dispose]: vi.fn()
        };
        const java = { sendCustomPayload: vi.fn(), [Symbol.dispose]: vi.fn() };
        const player = {
            asJava: () => java,
            getWorld: () => world,
            getName: () => 'Alice',
            getPosition: () => [0, 64, 0]
        };
        expect(() =>
            withPlayer(player as unknown as Player, settings, (peer) => {
                expect(peer.terrain.sample(-1, 64, -17).mapping).toBe(
                    'minecraft:old_growth_pine_taiga_DH-BSW_minecraft:stone'
                );
                expect(world.getChunk).toHaveBeenCalledWith(-1, -2);
                expect(chunk.getBlockStateId).toHaveBeenCalledWith({ x: 15, y: 64, z: 15 });
                throw new Error('callback failure');
            })
        ).toThrow('callback failure');
        for (const handle of [chunk, border, world, java]) expect(handle[Symbol.dispose]).toHaveBeenCalledOnce();
    });
    it('releases the Java handle when acquiring the world fails', () => {
        const values = defaultValues(schema);
        const java = { [Symbol.dispose]: vi.fn() };
        expect(() =>
            withPlayer(
                {
                    asJava: () => java,
                    getWorld: () => {
                        throw new Error('world unavailable');
                    }
                } as unknown as Player,
                { ...values.support, worlds: values.worlds },
                () => {}
            )
        ).toThrow('world unavailable');
        expect(java[Symbol.dispose]).toHaveBeenCalledOnce();
    });
    it('ignores Bedrock clients without acquiring terrain handles', () => {
        const values = defaultValues(schema),
            getWorld = vi.fn();
        expect(
            withPlayer(
                { asJava: () => undefined, getWorld } as unknown as Player,
                { ...values.support, worlds: values.worlds },
                () => {
                    throw new Error('called');
                }
            )
        ).toBe(false);
        expect(getWorld).not.toHaveBeenCalled();
    });
});
