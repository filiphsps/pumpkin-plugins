import { describe, expect, it } from 'vitest';
import { DEFAULT_LOD_GENERATION_RADIUS, iterateLodSectionsWithin, sectionKey } from './generation.ts';

const everywhere = {
    minX: Number.MIN_SAFE_INTEGER,
    maxX: Number.MAX_SAFE_INTEGER,
    minZ: Number.MIN_SAFE_INTEGER,
    maxZ: Number.MAX_SAFE_INTEGER,
};
const iterateLodSectionsAround = (blockX: number, blockZ: number, radius: number) =>
    iterateLodSectionsWithin(blockX, blockZ, radius, everywhere);
const listLodSectionsAround = (blockX: number, blockZ: number, radius: number) => [
    ...iterateLodSectionsAround(blockX, blockZ, radius),
];

describe('forced LOD section selection', () => {
    it('centers on the containing section and lists surrounding sections in outward rings', () => {
        expect(listLodSectionsAround(-1, 63, 1)).toEqual([
            { x: -1, z: 0 },
            { x: -2, z: -1 },
            { x: -2, z: 0 },
            { x: -2, z: 1 },
            { x: -1, z: -1 },
            { x: -1, z: 1 },
            { x: 0, z: -1 },
            { x: 0, z: 0 },
            { x: 0, z: 1 },
        ]);
    });

    it('defaults to one section and rejects a radius whose square exceeds the work limit', () => {
        expect(DEFAULT_LOD_GENERATION_RADIUS).toBe(0);
        expect(listLodSectionsAround(64, -64, DEFAULT_LOD_GENERATION_RADIUS)).toEqual([{ x: 1, z: -1 }]);
        expect(() => listLodSectionsAround(0, 0, -1)).toThrow('Radius must be between 0 and 31');
        expect(() => listLodSectionsAround(0, 0, 32)).toThrow(/4096/);
    });

    it('creates stable cache keys for signed section coordinates', () => {
        expect(sectionKey('world', -2, 3)).toBe('world:-2:3');
    });

    it('can lazily traverse the maximum accepted generation radius', () => {
        const sections = iterateLodSectionsAround(0, 0, 31);

        expect(sections.next()).toEqual({ value: { x: 0, z: 0 }, done: false });
        expect(sections.next()).toEqual({ value: { x: -1, z: -1 }, done: false });
    });
});
