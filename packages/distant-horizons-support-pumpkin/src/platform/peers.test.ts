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
        const border = { getCenterX: () => 0.5, getCenterZ: () => 0, getSize: () => 10, [Symbol.dispose]: vi.fn() };
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
                expect(peer.insideBorder(5, 0)).toBe(true);
                expect(peer.insideBorder(6, 0)).toBe(false);
                expect(peer.insideBorder(-5, 0)).toBe(true);
                expect(peer.insideBorder(-6, 0)).toBe(false);
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
        expect(() =>
            withPlayer(player as unknown as Player, { ...values.support, worlds: values.worlds }, (peer) => {
                peer.terrain.prepare?.({ high: 0, low: 6, detail: 6, x: -1, z: -2 });
            })
        ).toThrow('Chunk -1, -5 is not loaded');
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
