import { describe, expect, it } from 'vitest';
import {
    acquireChunk,
    type ChunkLoader,
    type TerrainGenerator,
    unavailableChunkLoader,
    unavailableTerrainGenerator
} from './chunks.ts';

describe('terrain chunk acquisition', () => {
    it('uses an already loaded chunk without asking either provider', () => {
        const chunk = { id: 1 };
        const unavailable: ChunkLoader = { load: () => ({ status: 'unavailable', reason: 'unused' }) };
        const generator: TerrainGenerator = { generate: () => ({ status: 'unavailable', reason: 'unused' }) };

        expect(acquireChunk({ x: -2, z: 4 }, () => chunk, unavailable, generator)).toEqual({ status: 'ready', chunk });
    });

    it('requests generation when saved terrain is missing and waits for pending work', () => {
        let generated = 0;
        const loader: ChunkLoader = { load: () => ({ status: 'not-found' }) };
        const generator: TerrainGenerator = {
            generate: () => {
                generated++;
                return { status: 'pending' };
            }
        };

        expect(acquireChunk({ x: 3, z: 5 }, () => undefined, loader, generator)).toEqual({ status: 'pending' });
        expect(generated).toBe(1);
    });

    it('returns a chunk made available by the loader', () => {
        const chunk = { id: 7 };
        let loaded: typeof chunk | undefined;
        const loader: ChunkLoader = {
            load: () => {
                loaded = chunk;
                return { status: 'ready' };
            }
        };
        const generator: TerrainGenerator = {
            generate: () => ({ status: 'failed', reason: 'must not generate a loaded chunk' })
        };

        expect(acquireChunk({ x: -3, z: 6 }, () => loaded, loader, generator)).toEqual({ status: 'ready', chunk });
    });

    it('reports platform stubs as unavailable until loading and generation APIs exist', () => {
        expect(unavailableChunkLoader.load({ x: 0, z: 0 })).toMatchObject({ status: 'unavailable' });
        expect(unavailableTerrainGenerator.generate({ x: 0, z: 0 })).toMatchObject({ status: 'unavailable' });
    });
});
