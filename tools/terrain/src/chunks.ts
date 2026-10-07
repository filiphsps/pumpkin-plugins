/** A chunk position in chunk coordinates. */
export interface ChunkPosition {
    x: number;
    z: number;
}

/** A result returned by a chunk-loading or terrain-generation provider. */
export type TerrainOperationResult =
    | { status: 'ready' }
    | { status: 'pending' }
    | { status: 'unavailable'; reason: string }
    | { status: 'failed'; reason: string };

/** The additional result a loader can return when no saved chunk exists. */
export type ChunkLoadResult = TerrainOperationResult | { status: 'not-found' };

/** Loads a saved chunk and reports whether the operation is ready, pending or unsupported. */
export interface ChunkLoader {
    /** Repeated calls for a pending position should continue the same operation. */
    load(position: ChunkPosition): ChunkLoadResult;
}

/** Requests generation for a chunk that is not already loaded or saved. */
export interface TerrainGenerator {
    /** Repeated calls for a pending position should continue the same operation. */
    generate(position: ChunkPosition): TerrainOperationResult;
}

/** Result of making one chunk available to a terrain reader. */
export type ChunkAcquisition<T> =
    | { status: 'ready'; chunk: T }
    | { status: 'pending' }
    | { status: 'unavailable'; reason: string }
    | { status: 'failed'; reason: string };

/** Returns a loaded chunk or asks the configured providers to load or generate it. */
export function acquireChunk<T>(
    position: ChunkPosition,
    getLoadedChunk: () => T | null | undefined,
    loader: ChunkLoader,
    generator: TerrainGenerator
): ChunkAcquisition<NonNullable<T>> {
    const loaded = getLoadedChunk();
    if (loaded !== undefined && loaded !== null) return { status: 'ready', chunk: loaded };

    const loadResult = loader.load(position);
    if (loadResult.status === 'pending') return loadResult;
    if (loadResult.status === 'failed') return loadResult;
    if (loadResult.status === 'ready') {
        const chunk = getLoadedChunk();
        return chunk === undefined || chunk === null ? { status: 'pending' } : { status: 'ready', chunk };
    }

    const generationResult = generator.generate(position);
    if (generationResult.status === 'ready') {
        const chunk = getLoadedChunk();
        return chunk === undefined || chunk === null ? { status: 'pending' } : { status: 'ready', chunk };
    }
    if (generationResult.status === 'unavailable' && loadResult.status === 'unavailable') {
        return { status: 'unavailable', reason: `${loadResult.reason}; ${generationResult.reason}` };
    }
    return generationResult;
}

/** Provider stubs for platforms without saved-chunk loading support. */
export const unavailableChunkLoader: ChunkLoader = {
    load: () => ({ status: 'unavailable', reason: 'Saved chunk loading is unavailable' })
};

/** Provider stubs for platforms without terrain-generation support. */
export const unavailableTerrainGenerator: TerrainGenerator = {
    generate: () => ({ status: 'unavailable', reason: 'Terrain generation is unavailable' })
};
