import type { Player } from 'pumpkin:plugin/player@0.1.0';
import { defaultValues } from '@pumpkin-plugins/config';
import { describe, expect, it, vi } from 'vitest';
import { schema } from '../config/schema.ts';
import { withPlayer } from './peers.ts';

vi.mock('pumpkin:plugin/world@0.1.0', () => ({
    blockStateToInfo: () => ({ name: 'minecraft:stone', properties: [] })
}));
vi.mock('pumpkin:plugin/text@0.1.0', () => ({ TextComponent: { text: (value: string) => ({ value }) } }));

describe('QuickJS resource compatibility', () => {
    it('serves terrain when host resources expose no Symbol.dispose method', () => {
        const values = defaultValues(schema);
        const java = { sendCustomPayload: vi.fn() };
        const world = {
            getName: () => 'world',
            getDimension: () => 'minecraft:overworld',
            getMinY: () => -64,
            getWorldBorder: () => ({ getCenterX: () => 0, getCenterZ: () => 0, getSize: () => 60000000 }),
            getBlockStateId: () => 1,
            getBiome: () => 'plains',
            getTopBlockY: () => 64,
            getSkyLight: () => 15,
            getBlockLight: () => 0,
            getChunk: () => ({})
        };
        const player = {
            asJava: () => java,
            getWorld: () => world,
            getName: () => 'Alex',
            getPosition: () => [0, 64, 0]
        } as unknown as Player;
        expect(
            withPlayer(player, { ...values.support, worlds: values.worlds }, (peer) => {
                expect(
                    peer.terrain.prepare?.({
                        originX: 0,
                        originZ: 0,
                        width: 64,
                        depth: 64,
                        minY: -64,
                        height: 384
                    })
                ).toEqual({ status: 'ready' });
                expect(peer.terrain.sample(0, 64, 0).skyLight).toBe(15);
                peer.send(new Uint8Array([1]));
            })
        ).toBe(true);
        expect(java.sendCustomPayload).toHaveBeenCalledOnce();
    });
});
