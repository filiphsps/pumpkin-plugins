import type { TerrainRegion } from '@pumpkin-plugins/terrain';
import { SECTION_SIZE_BLOCKS } from '../protocol/constants.ts';

/** Radius used when a forced LOD capture does not specify one. */
export const DEFAULT_LOD_GENERATION_RADIUS = 0;
/** Maximum selected sections for one forced capture request. */
export const MAX_LOD_GENERATION_SECTIONS = 4_096;
/** Maximum square radius whose selected area fits the forced-capture section limit. */
export const MAX_LOD_GENERATION_RADIUS = Math.floor((Math.floor(Math.sqrt(MAX_LOD_GENERATION_SECTIONS)) - 1) / 2);

/**
 * Returns the number of sections selected by a square radius after enforcing the work limit.
 *
 * @param radius - Radius in LOD sections
 * @returns The selected section count
 * @throws {RangeError} When the radius is invalid or exceeds the selected-section limit
 */
export function lodGenerationSectionCount(radius: number): number {
    const rangeError = new RangeError(
        `Radius must be between 0 and ${MAX_LOD_GENERATION_RADIUS} LOD sections (at most ${MAX_LOD_GENERATION_SECTIONS} requested sections).`,
    );
    if (!Number.isSafeInteger(radius) || radius < 0 || radius > MAX_LOD_GENERATION_RADIUS) throw rangeError;

    const diameter = radius * 2 + 1;
    if (diameter > Math.floor(MAX_LOD_GENERATION_SECTIONS / diameter)) throw rangeError;
    return diameter * diameter;
}

/** A LOD section in signed section coordinates. */
export interface LodSectionCoordinate {
    x: number;
    z: number;
}

/** Inclusive section-coordinate rectangle used to clip a forced selection. */
export interface LodSectionBounds {
    maxX: number;
    maxZ: number;
    minX: number;
    minZ: number;
}

/** Iterates the containing section first, then the surrounding square in outward rings, clipped to the bounds. */
export function* iterateLodSectionsWithin(
    blockX: number,
    blockZ: number,
    radius: number,
    bounds: LodSectionBounds,
): Generator<LodSectionCoordinate> {
    lodGenerationSectionCount(radius);
    if (!Number.isSafeInteger(blockX) || !Number.isSafeInteger(blockZ)) {
        throw new RangeError('Block coordinates must be safe integers.');
    }
    const centerX = Math.floor(blockX / SECTION_SIZE_BLOCKS);
    const centerZ = Math.floor(blockZ / SECTION_SIZE_BLOCKS);
    const clipped = {
        minX: Math.max(centerX - radius, bounds.minX),
        maxX: Math.min(centerX + radius, bounds.maxX),
        minZ: Math.max(centerZ - radius, bounds.minZ),
        maxZ: Math.min(centerZ + radius, bounds.maxZ),
    };
    if (clipped.minX > clipped.maxX || clipped.minZ > clipped.maxZ) return;
    yield* iterateRings(centerX, centerZ, radius, clipped);
}

/** Block region of one LOD section over the full world height. */
export function sectionRegion(section: LodSectionCoordinate, world: { minY: number; height: number }): TerrainRegion {
    return {
        originX: section.x * SECTION_SIZE_BLOCKS,
        originZ: section.z * SECTION_SIZE_BLOCKS,
        width: SECTION_SIZE_BLOCKS,
        depth: SECTION_SIZE_BLOCKS,
        minY: world.minY,
        height: world.height,
    };
}

/** Stable cache key scoped to the world name and signed section coordinates. */
export function sectionKey(level: string, x: number, z: number): string {
    return `${level}:${x}:${z}`;
}

function* iterateRings(
    centerX: number,
    centerZ: number,
    radius: number,
    bounds: LodSectionBounds,
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
