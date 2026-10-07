import { SECTION_SIZE_BLOCKS } from '../protocol/constants.ts';
import { sectionKey } from '../session.ts';
import type { LodCache } from './cache.ts';

export { DEFAULT_LOD_MAP_RADIUS, MAX_LOD_MAP_RADIUS } from './map-constants.ts';

/** Renders cached LOD sections around a block position; the center cell represents its containing section. */
export function renderLodMap(cache: LodCache, level: string, blockX: number, blockZ: number, radius: number): string[] {
    const centerX = Math.floor(blockX / SECTION_SIZE_BLOCKS);
    const centerZ = Math.floor(blockZ / SECTION_SIZE_BLOCKS);
    const lines = [`LOD map for ${level}; center section ${centerX}, ${centerZ}; radius ${radius}. North is up.`];

    for (let z = centerZ + radius; z >= centerZ - radius; z--) {
        let row = '';
        for (let x = centerX - radius; x <= centerX + radius; x++) {
            const cached = cache.has(sectionKey(level, x, z));
            if (x === centerX && z === centerZ) row += cached ? '§e◆' : '§8◇';
            else row += cached ? '§a█' : '§8·';
        }
        lines.push(row);
    }

    lines.push('§a█ built  §8· empty  §e◆ built center  §8◇ empty center (one cell = 64 blocks / 4×4 chunks)');
    return lines;
}
