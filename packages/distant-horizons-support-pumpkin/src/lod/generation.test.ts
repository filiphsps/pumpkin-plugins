import { describe, expect, it } from 'vitest';
import {
    DEFAULT_LOD_GENERATION_RADIUS,
    iterateLodSectionsAround,
    listLodSectionsAround,
    MAX_LOD_GENERATION_RADIUS,
    sectionKey
} from './generation.ts';

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
            { x: 0, z: 1 }
        ]);
    });

    it('defaults to one section and rejects radii outside the generation bound', () => {
        expect(DEFAULT_LOD_GENERATION_RADIUS).toBe(0);
        expect(MAX_LOD_GENERATION_RADIUS).toBe(16_384);
        expect(listLodSectionsAround(64, -64, DEFAULT_LOD_GENERATION_RADIUS)).toEqual([{ x: 1, z: -1 }]);
        expect(() => listLodSectionsAround(0, 0, -1)).toThrow('Radius must be between 0 and 16384');
        expect(() => listLodSectionsAround(0, 0, 16_385)).toThrow('Radius must be between 0 and 16384');
    });

    it('creates stable cache keys for signed section coordinates', () => {
        expect(sectionKey('world', -2, 3)).toBe('world:-2:3');
    });

    it('can lazily traverse the maximum generation radius', () => {
        const sections = iterateLodSectionsAround(0, 0, 16_384);

        expect(sections.next()).toEqual({ value: { x: 0, z: 0 }, done: false });
        expect(sections.next()).toEqual({ value: { x: -1, z: -1 }, done: false });
    });
});
