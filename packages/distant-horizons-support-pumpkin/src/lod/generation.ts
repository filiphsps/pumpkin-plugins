import { SECTION_SIZE_BLOCKS } from '../protocol/constants.ts';

/** Radius used when a forced LOD capture does not specify one. */
export const DEFAULT_LOD_GENERATION_RADIUS = 0;
/** Maximum forced capture radius, in LOD sections. */
export const MAX_LOD_GENERATION_RADIUS = 4;

/** A LOD section in signed section coordinates. */
export interface LodSectionCoordinate {
    x: number;
    z: number;
}

/** Lists the containing section first, followed by the surrounding square in outward rings. */
export function listLodSectionsAround(
    blockX: number,
    blockZ: number,
    radius = DEFAULT_LOD_GENERATION_RADIUS
): LodSectionCoordinate[] {
    if (!Number.isSafeInteger(radius) || radius < 0 || radius > MAX_LOD_GENERATION_RADIUS) {
        throw new RangeError(`Radius must be between 0 and ${MAX_LOD_GENERATION_RADIUS} LOD sections.`);
    }
    if (!Number.isSafeInteger(blockX) || !Number.isSafeInteger(blockZ)) {
        throw new RangeError('Block coordinates must be safe integers.');
    }

    const centerX = Math.floor(blockX / SECTION_SIZE_BLOCKS);
    const centerZ = Math.floor(blockZ / SECTION_SIZE_BLOCKS);
    const sections: LodSectionCoordinate[] = [];
    for (let ring = 0; ring <= radius; ring++) {
        for (let x = centerX - ring; x <= centerX + ring; x++) {
            for (let z = centerZ - ring; z <= centerZ + ring; z++) {
                if (Math.max(Math.abs(x - centerX), Math.abs(z - centerZ)) === ring) sections.push({ x, z });
            }
        }
    }
    return sections;
}
