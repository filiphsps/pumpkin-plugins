import { SECTION_SIZE_BLOCKS } from '../protocol/constants.ts';

/** Radius used when a forced LOD capture does not specify one. */
export const DEFAULT_LOD_GENERATION_RADIUS = 0;
/** Maximum forced capture radius, in LOD sections. */
export const MAX_LOD_GENERATION_RADIUS = 16_384;

/** A LOD section in signed section coordinates. */
export interface LodSectionCoordinate {
    x: number;
    z: number;
}

/** Inclusive section-coordinate rectangle used to clip a forced selection. */
export interface LodSectionBounds {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
}

/** Iterates the containing section first, followed by the surrounding square in outward rings. */
export function* iterateLodSectionsAround(
    blockX: number,
    blockZ: number,
    radius = DEFAULT_LOD_GENERATION_RADIUS
): Generator<LodSectionCoordinate> {
    if (!Number.isSafeInteger(radius) || radius < 0 || radius > MAX_LOD_GENERATION_RADIUS) {
        throw new RangeError(`Radius must be between 0 and ${MAX_LOD_GENERATION_RADIUS} LOD sections.`);
    }
    if (!Number.isSafeInteger(blockX) || !Number.isSafeInteger(blockZ)) {
        throw new RangeError('Block coordinates must be safe integers.');
    }

    const centerX = Math.floor(blockX / SECTION_SIZE_BLOCKS);
    const centerZ = Math.floor(blockZ / SECTION_SIZE_BLOCKS);
    yield* iterateRings(centerX, centerZ, radius, {
        minX: centerX - radius,
        maxX: centerX + radius,
        minZ: centerZ - radius,
        maxZ: centerZ + radius
    });
}

/** Iterates only the selected ring coordinates inside an inclusive section rectangle. */
export function* iterateLodSectionsWithin(
    blockX: number,
    blockZ: number,
    radius: number,
    bounds: LodSectionBounds
): Generator<LodSectionCoordinate> {
    if (!Number.isSafeInteger(radius) || radius < 0 || radius > MAX_LOD_GENERATION_RADIUS) {
        throw new RangeError(`Radius must be between 0 and ${MAX_LOD_GENERATION_RADIUS} LOD sections.`);
    }
    if (!Number.isSafeInteger(blockX) || !Number.isSafeInteger(blockZ)) {
        throw new RangeError('Block coordinates must be safe integers.');
    }
    const centerX = Math.floor(blockX / SECTION_SIZE_BLOCKS);
    const centerZ = Math.floor(blockZ / SECTION_SIZE_BLOCKS);
    const clipped = {
        minX: Math.max(centerX - radius, bounds.minX),
        maxX: Math.min(centerX + radius, bounds.maxX),
        minZ: Math.max(centerZ - radius, bounds.minZ),
        maxZ: Math.min(centerZ + radius, bounds.maxZ)
    };
    if (clipped.minX > clipped.maxX || clipped.minZ > clipped.maxZ) return;
    yield* iterateRings(centerX, centerZ, radius, clipped);
}

/** Materializes the selected sections; use the iterator for a large radius. */
export function listLodSectionsAround(
    blockX: number,
    blockZ: number,
    radius = DEFAULT_LOD_GENERATION_RADIUS
): LodSectionCoordinate[] {
    return [...iterateLodSectionsAround(blockX, blockZ, radius)];
}

/** Stable cache key scoped to the world name and signed section coordinates. */
export function sectionKey(level: string, x: number, z: number): string {
    return `${level}:${x}:${z}`;
}

function* iterateRings(
    centerX: number,
    centerZ: number,
    radius: number,
    bounds: LodSectionBounds
): Generator<LodSectionCoordinate> {
    for (let ring = 0; ring <= radius; ring++) {
        const left = centerX - ring;
        const right = centerX + ring;
        const bottom = centerZ - ring;
        const top = centerZ + ring;
        const minX = Math.max(left, bounds.minX);
        const maxX = Math.min(right, bounds.maxX);
        const minZ = Math.max(bottom, bounds.minZ);
        const maxZ = Math.min(top, bounds.maxZ);
        if (minX > maxX || minZ > maxZ) continue;

        if (left >= minX && left <= maxX) {
            for (let z = minZ; z <= maxZ; z++) yield { x: left, z };
        }
        const innerMinX = Math.max(left + 1, minX);
        const innerMaxX = Math.min(right - 1, maxX);
        if (bottom >= minZ && bottom <= maxZ) {
            for (let x = innerMinX; x <= innerMaxX; x++) yield { x, z: bottom };
        }
        if (top !== bottom && top >= minZ && top <= maxZ) {
            for (let x = innerMinX; x <= innerMaxX; x++) yield { x, z: top };
        }
        if (right !== left && right >= minX && right <= maxX) {
            for (let z = minZ; z <= maxZ; z++) yield { x: right, z };
        }
    }
}
