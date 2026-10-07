import { MemoryFiles } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it } from 'vitest';
import { sectionKey } from '../session.ts';
import { LodCache } from './cache.ts';
import { renderLodMap } from './map.ts';

function setup() {
    const cache = new LodCache(new MemoryFiles(), 16, 16);
    return {
        cache,
        lod: (level: string, x: number, z: number) =>
            cache.put(sectionKey(level, x, z), { updated: 1, data: new Uint8Array(64) })
    };
}

const plain = (line: string | undefined) => line?.replace(/§./g, '');

describe('LOD map', () => {
    it('centers on the LOD section containing the block and marks the center cell', () => {
        const { cache, lod } = setup();
        lod('overworld', -1, -1);

        const lines = renderLodMap(cache, 'overworld', -1, -1, 1);

        expect(plain(lines[0])).toContain('center section -1, -1');
        expect(lines.slice(1, 4).map(plain)).toEqual(['···', '·◆·', '···']);
        expect(plain(lines.at(-1))).toContain('built');
        expect(lines.join('\n')).toContain('§a█');
        expect(lines.join('\n')).toContain('§8·');
    });

    it('uses block coordinates for a specific position and floors negative coordinates', () => {
        const { cache, lod } = setup();
        lod('nether', 1, -2);

        const lines = renderLodMap(cache, 'nether', 127, -65, 0);

        expect(plain(lines[0])).toContain('center section 1, -2');
        expect(plain(lines[1])).toBe('◆');
    });

    it('documents that each cell is a 64-block LOD section', () => {
        const { cache } = setup();

        expect(renderLodMap(cache, 'overworld', 0, 0, 0).map(plain).join('\n')).toContain('64 blocks');
    });
});
