import { describe, expect, it } from 'vitest';
import { TerrainCapture, type TerrainRegion, type TerrainSource } from './capture.ts';

const region: TerrainRegion = { originX: -1, originZ: -1, width: 2, depth: 2, minY: 0, height: 3 };

describe('terrain capture', () => {
    it('samples within budget and groups consecutive material runs', () => {
        let reads = 0;
        const source: TerrainSource = {
            minY: 0,
            height: 3,
            sample: (_x, y) => {
                reads++;
                return { material: y === 2 ? 'air' : 'stone', skyLight: 15, blockLight: 0 };
            }
        };
        const capture = new TerrainCapture(region, { isEmpty: (material) => material === 'air' });

        expect(capture.step(source, 5)).toBe(false);
        expect(reads).toBe(5);
        expect(capture.progress()).toBeCloseTo(5 / 12);
        expect(() => capture.result()).toThrow('incomplete');
        while (!capture.step(source, 7)) {}

        expect(reads).toBe(12);
        expect(capture.result()).toEqual({
            materials: ['air', 'stone'],
            columns: Array.from({ length: 4 }, () => [
                { materialId: 0, startY: 2, height: 1, skyLight: 15, blockLight: 0 },
                { materialId: 1, startY: 0, height: 2, skyLight: 15, blockLight: 0 }
            ])
        });
    });

    it('skips empty blocks above the surface while preserving the captured result', () => {
        const tallRegion: TerrainRegion = { originX: 0, originZ: 0, width: 1, depth: 1, minY: -10, height: 20 };
        const sample = (_x: number, y: number, _z: number) => ({
            material: y > -8 ? 'air' : 'stone',
            skyLight: 15,
            blockLight: 0
        });
        const baseline = new TerrainCapture(tallRegion, { isEmpty: (material) => material === 'air' });
        baseline.step({ minY: -10, height: 20, sample }, 20);

        let reads = 0;
        const optimized = new TerrainCapture(tallRegion, { isEmpty: (material) => material === 'air' });
        optimized.step(
            {
                minY: -10,
                height: 20,
                sample: (x, y, z) => {
                    reads++;
                    return sample(x, y, z);
                },
                top: () => -8
            },
            20
        );

        expect(reads).toBeLessThan(20);
        expect(optimized.result()).toEqual(baseline.result());
    });

    it('rejects changed world dimensions and captures that exceed their segment limit', () => {
        const capture = new TerrainCapture(region, { maxSegments: 1 });
        const source: TerrainSource = {
            minY: 0,
            height: 3,
            sample: (_x, y) => ({ material: String(y), skyLight: 0, blockLight: 0 })
        };
        expect(() => capture.step({ ...source, height: 4 }, 1)).toThrow('height');
        expect(() => capture.step(source, 12)).toThrow('too complex');
    });

    it('rejects regions whose final block coordinates exceed safe integers', () => {
        expect(
            () =>
                new TerrainCapture({
                    ...region,
                    originX: Number.MAX_SAFE_INTEGER,
                    width: 2
                })
        ).toThrow('Invalid terrain region');
        expect(
            () =>
                new TerrainCapture({
                    ...region,
                    minY: Number.MAX_SAFE_INTEGER,
                    height: 2
                })
        ).toThrow('Invalid terrain region');
    });
});
