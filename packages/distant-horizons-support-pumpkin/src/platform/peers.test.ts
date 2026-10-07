import { defaultValues } from '@pumpkin-plugins/config';
import { MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    lookup: vi.fn(() => ({ name: 'minecraft:stone', properties: [] as [string, string][] }))
}));
vi.mock('pumpkin:plugin/world@0.1.0', () => ({ blockStateToInfo: state.lookup }));

import type { Player } from 'pumpkin:plugin/player@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { schema } from '../config/schema.ts';
import { serverPeers, withPlayer } from './peers.ts';

describe('Pumpkin terrain adapter', () => {
    it('reads negative coordinates through world accessors and releases world handles', () => {
        const values = defaultValues(schema),
            settings = { ...values.support, worlds: values.worlds };
        state.lookup.mockReturnValueOnce({
            name: 'minecraft:oak_log',
            properties: [
                ['waterlogged', 'false'],
                ['axis', 'y']
            ]
        });
        const chunk = {
            getBlockStateId: vi.fn(() => {
                throw new Error('Chunk unloaded');
            }),
            getBiome: vi.fn(() => {
                throw new Error('Chunk unloaded');
            }),
            getTopBlockY: vi.fn(() => {
                throw new Error('Chunk unloaded');
            }),
            getSkyLight: vi.fn(() => {
                throw new Error('Chunk unloaded');
            }),
            getBlockLight: vi.fn(() => {
                throw new Error('Chunk unloaded');
            }),
            [Symbol.dispose]: vi.fn()
        };
        const border = { getCenterX: () => 0.5, getCenterZ: () => 0, getSize: () => 10, [Symbol.dispose]: vi.fn() };
        const world = {
            getName: () => 'world',
            getDimension: () => 'minecraft:overworld',
            getMinY: () => -64,
            getWorldBorder: () => border,
            getBlockStateId: vi.fn(() => 1),
            getBiome: vi.fn(() => 'old-growth-pine-taiga'),
            getTopBlockY: vi.fn(() => 80),
            getSkyLight: vi.fn(() => 15),
            getBlockLight: vi.fn(() => 0),
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
                expect(peer.insideBorder(5, 0)).toBe(true);
                expect(peer.insideBorder(6, 0)).toBe(false);
                expect(peer.insideBorder(-5, 0)).toBe(true);
                expect(peer.insideBorder(-6, 0)).toBe(false);
                expect(peer.terrain.sample(-1, 64, -17).material).toBe(
                    'minecraft:old_growth_pine_taiga_DH-BSW_minecraft:oak_log_STATE_{axis:y}{waterlogged:false}'
                );
                expect(world.getBlockStateId).toHaveBeenCalledWith({ x: -1, y: 64, z: -17 });
                expect(world.getBiome).toHaveBeenCalledWith({ x: -1, y: 80, z: -17 });
                expect(world.getSkyLight).toHaveBeenCalledWith({ x: -1, y: 65, z: -17 });
                expect(world.getBlockLight).toHaveBeenCalledWith({ x: -1, y: 65, z: -17 });
                expect(peer.terrain.top?.(-1, -17)).toBe(80);
                expect(world.getTopBlockY).toHaveBeenNthCalledWith(1, -1, -17);
                expect(world.getTopBlockY).toHaveBeenNthCalledWith(2, -1, -17);
                expect(world.getChunk).not.toHaveBeenCalled();
                expect(chunk.getBlockStateId).not.toHaveBeenCalled();
                expect(chunk.getBiome).not.toHaveBeenCalled();
                expect(chunk.getSkyLight).not.toHaveBeenCalled();
                expect(chunk.getBlockLight).not.toHaveBeenCalled();
                expect(chunk.getTopBlockY).not.toHaveBeenCalled();
                throw new Error('callback failure');
            })
        ).toThrow('callback failure');
        for (const handle of [border, world, java]) expect(handle[Symbol.dispose]).toHaveBeenCalledOnce();
    });
    it('checks all chunks before block reads and releases acquired chunks when the last one is missing', () => {
        const values = defaultValues(schema);
        const chunks = Array.from({ length: 15 }, () => ({ [Symbol.dispose]: vi.fn() }));
        const getChunk = vi.fn(() => chunks[getChunk.mock.calls.length - 1]);
        const border = { getCenterX: () => 0, getCenterZ: () => 0, getSize: () => 60000000, [Symbol.dispose]: vi.fn() };
        const world = {
            getName: () => 'world',
            getDimension: () => 'minecraft:overworld',
            getMinY: () => -64,
            getWorldBorder: () => border,
            getChunk,
            [Symbol.dispose]: vi.fn()
        };
        const java = { [Symbol.dispose]: vi.fn() };
        const player = {
            asJava: () => java,
            getWorld: () => world,
            getName: () => 'Alice',
            getPosition: () => [0, 64, 0]
        };
        expect(
            withPlayer(player as unknown as Player, { ...values.support, worlds: values.worlds }, (peer) => {
                expect(
                    peer.terrain.prepare?.({
                        originX: -64,
                        originZ: -128,
                        width: 64,
                        depth: 64,
                        minY: -64,
                        height: 384
                    })
                ).toMatchObject({
                    status: 'unavailable',
                    reason: expect.stringContaining('Chunk -1, -5 is not loaded')
                });
            })
        ).toBe(true);
        expect(getChunk).toHaveBeenCalledTimes(16);
        expect(getChunk).toHaveBeenNthCalledWith(1, -4, -8);
        for (const handle of [...chunks, border, world, java]) expect(handle[Symbol.dispose]).toHaveBeenCalledOnce();
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

describe('server player lookup', () => {
    const values = defaultValues(schema),
        settings = { ...values.support, worlds: values.worlds };

    it('returns false when a player disconnected before lookup', () => {
        const getPlayerByName = vi.fn(() => undefined);
        const log = new MemoryLogger();
        const peers = serverPeers({ getPlayerByName } as unknown as Server, settings, log);

        expect(peers.withPeer('Alice', () => {})).toBe(false);
        expect(getPlayerByName).toHaveBeenCalledWith('Alice');
        expect(log.of('warn')).toEqual([]);
    });

    it('warns and releases player handles when terrain access fails', () => {
        const java = { [Symbol.dispose]: vi.fn() };
        const player = {
            asJava: () => java,
            getWorld: () => {
                throw new Error('world unavailable');
            },
            [Symbol.dispose]: vi.fn()
        };
        const log = new MemoryLogger();
        const peers = serverPeers({ getPlayerByName: () => player } as unknown as Server, settings, log);

        expect(peers.withPeer('Alice', () => {})).toBe(false);
        expect(log.of('warn')).toEqual([
            'DistantHorizonsSupportPumpkin: cannot access player terrain: Error: world unavailable'
        ]);
        expect(java[Symbol.dispose]).toHaveBeenCalledOnce();
        expect(player[Symbol.dispose]).toHaveBeenCalledOnce();
    });
});
