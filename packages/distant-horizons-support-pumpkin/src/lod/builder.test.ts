import { describe, expect, it } from 'vitest';
import { Reader } from '../protocol/bytes.ts';
import { LodBuilder } from './builder.ts';

const section = { high: 0, low: 6, detail: 6, x: 0, z: 0 };

describe('LOD builder', () => {
    it('bounds sampling and encodes top-down columns using the client v1 DTO layout', () => {
        let reads = 0;
        const terrain = {
            minY: -64,
            height: 3,
            sample: (_x: number, y: number, _z: number) => {
                reads++;
                return {
                    mapping:
                        y === -62 ? 'minecraft:plains_DH-BSW_minecraft:air' : 'minecraft:plains_DH-BSW_minecraft:stone',
                    sky: y === -62 ? 15 : 4,
                    block: 2
                };
            }
        };
        const builder = new LodBuilder(section, -64, 3);
        expect(builder.step(terrain, 7)).toBe(false);
        expect(reads).toBe(7);
        expect(() => builder.finish(100)).toThrow('incomplete');
        while (!builder.step(terrain, 1000)) {}
        expect(reads).toBe(4096 * 3);
        const input = new Reader(builder.finish(100));
        expect(input.words()).toEqual({ high: 0, low: 6 });
        expect(input.int()).toBe(0);
        const columns = new Reader(input.bytes(input.int()));
        for (let i = 0; i < 4096; i++) {
            expect(columns.short()).toBe(2);
            expect(columns.words()).toEqual({ high: 0x2f002001, low: 0 });
            expect(columns.words()).toEqual({ high: 0x24000002, low: 1 });
        }
        columns.end();
        for (let i = 0; i < 4; i++) expect(input.int()).toBe(0);
        expect(input.bytes(input.int())).toEqual(new Uint8Array(4096).fill(9));
        expect(input.bytes(input.int())).toEqual(new Uint8Array(4096));
        const mapping = new Reader(input.bytes(input.int()));
        expect(mapping.int()).toBe(2);
        expect(mapping.string()).toBe('minecraft:plains_DH-BSW_minecraft:air');
        expect(mapping.string()).toBe('minecraft:plains_DH-BSW_minecraft:stone');
        mapping.end();
        expect(input.byte()).toBe(1);
        expect(input.byte()).toBe(0);
        expect(input.bool()).toBe(true);
        expect(input.bool()).toBe(false);
        expect(input.bool()).toBe(false);
        expect(input.timestamp()).toBe(100);
        expect(input.timestamp()).toBe(100);
        input.end();
    });
    it('keeps caves and material changes instead of flattening a column', () => {
        const builder = new LodBuilder(section, 0, 3);
        expect(
            builder.step(
                { minY: 0, height: 3, sample: (_x, y) => ({ mapping: y === 1 ? 'air' : 'stone', sky: 0, block: 0 }) },
                12288
            )
        ).toBe(true);
        const input = new Reader(builder.finish(1));
        input.words();
        input.int();
        const data = new Reader(input.bytes(input.int()));
        expect(data.short()).toBe(3);
        expect(data.words()).toEqual({ high: 0x2001, low: 0 });
        expect(data.words()).toEqual({ high: 0x1001, low: 1 });
        expect(data.words()).toEqual({ high: 1, low: 0 });
    });
    it('rejects overly complex terrain before retaining an unbounded set of points', () => {
        const builder = new LodBuilder(section, 0, 33);
        const terrain = {
            minY: 0,
            height: 33,
            sample: (_x: number, y: number) => ({ mapping: y % 2 ? 'stone' : 'air', sky: 0, block: 0 })
        };
        expect(() => builder.step(terrain, 4096 * 33)).toThrow('too complex');
    });
    it('propagates missing terrain and refuses a changed world height', () => {
        const b = new LodBuilder(section, 0, 3);
        expect(() =>
            b.step(
                {
                    minY: 0,
                    height: 4,
                    sample: () => {
                        throw new Error('unloaded');
                    }
                },
                1
            )
        ).toThrow('height');
        expect(() =>
            b.step(
                {
                    minY: 0,
                    height: 3,
                    sample: () => {
                        throw new Error('unloaded');
                    }
                },
                1
            )
        ).toThrow('unloaded');
        expect(() => new LodBuilder({ ...section, detail: 7 }, 0, 3)).toThrow('dimensions');
    });
});
