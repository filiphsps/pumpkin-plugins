import type { TerrainRegion } from '@pumpkin-plugins/terrain';
import { CHUNK_SIZE_BLOCKS } from './protocol/constants.ts';

/** Inclusive chunk-coordinate bounds touched by a terrain region. */
export interface ChunkBounds {
    firstX: number;
    firstZ: number;
    lastX: number;
    lastZ: number;
}

/** Chunk coordinate used to prepare terrain. */
export interface ChunkCoordinate {
    x: number;
    z: number;
}

/** Finds the inclusive chunk-coordinate bounds touched by a block-space region. */
export function chunkBounds(region: TerrainRegion): ChunkBounds {
    return {
        firstX: Math.floor(region.originX / CHUNK_SIZE_BLOCKS),
        lastX: Math.floor((region.originX + region.width - 1) / CHUNK_SIZE_BLOCKS),
        firstZ: Math.floor(region.originZ / CHUNK_SIZE_BLOCKS),
        lastZ: Math.floor((region.originZ + region.depth - 1) / CHUNK_SIZE_BLOCKS),
    };
}

/** Iterates chunk coordinates in bounds in x-major order. */
export function* iterateChunkCoordinates(bounds: ChunkBounds): Generator<ChunkCoordinate> {
    for (let x = bounds.firstX; x <= bounds.lastX; x++) {
        for (let z = bounds.firstZ; z <= bounds.lastZ; z++) yield { x, z };
    }
}
