import { SECTION_SIZE_BLOCKS } from '../protocol/constants.ts';
import { sectionKey } from '../session.ts';
import type { LodCache } from './cache.ts';
import { DEFAULT_LOD_MAP_RADIUS, MAX_LOD_MAP_RADIUS } from './map-constants.ts';

export { DEFAULT_LOD_MAP_RADIUS, MAX_LOD_MAP_RADIUS };

const MAX_DISPLAY_RADIUS = 10;

/** Renders cached LOD sections around a block position; the center cell represents its containing section. */
export function renderLodMap(cache: LodCache, level: string, blockX: number, blockZ: number, radius: number): string[] {
    if (!Number.isSafeInteger(radius) || radius < 0 || radius > MAX_LOD_MAP_RADIUS) {
        throw new RangeError(`Radius must be between 0 and ${MAX_LOD_MAP_RADIUS} LOD sections.`);
    }
    const centerX = Math.floor(blockX / SECTION_SIZE_BLOCKS);
    const centerZ = Math.floor(blockZ / SECTION_SIZE_BLOCKS);
    const lines = [`LOD map for ${level}; center section ${centerX}, ${centerZ}; radius ${radius}. North is up.`];
    const displayRadius = Math.min(radius, MAX_DISPLAY_RADIUS);
    const sectionOffset = (offset: number): number =>
        displayRadius === 0 ? 0 : Math.round((offset * radius) / displayRadius);

    for (let rowOffset = displayRadius; rowOffset >= -displayRadius; rowOffset--) {
        const z = centerZ + sectionOffset(rowOffset);
        let rowText = '';
        for (let column = -displayRadius; column <= displayRadius; column++) {
            const x = centerX + sectionOffset(column);
            const cached = cache.has(sectionKey(level, x, z));
            if (column === 0 && rowOffset === 0) rowText += cached ? '§e█' : '§7█';
            else rowText += cached ? '§a█' : '§8█';
        }
        lines.push(rowText);
    }

    lines.push(
        radius > displayRadius
            ? `§a█ built  §8█ empty  Center: §e█ built, §7█ empty (downsampled to ${displayRadius * 2 + 1}×${displayRadius * 2 + 1})`
            : '§a█ built  §8█ empty  Center: §e█ built, §7█ empty (one cell = 64 blocks / 4×4 chunks)'
    );
    return lines;
}
