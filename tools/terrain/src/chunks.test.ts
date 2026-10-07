import { describe, expect, expectTypeOf, it } from 'vitest';
import {
    acquireChunk,
    type ChunkAcquisition,
    type ChunkLoader,
    type TerrainGenerator,
    unavailableChunkLoader,
    unavailableTerrainGenerator
} from './chunks.ts';

describe('terrain chunk acquisition', () => {
    it.each([null, undefined])('treats %s as an absent loaded chunk', (absent) => {
        const loader: ChunkLoader = { load: () => ({ status: 'unavailable', reason: 'loading unavailable' }) };
        const generator: TerrainGenerator = {
            generate: () => ({ status: 'unavailable', reason: 'generation unavailable' })
        };

        const result = acquireChunk<{ id: number } | null | undefined>(
            { x: 0, z: 0 },
            () => absent as { id: number } | null | undefined,
            loader,
            generator
        );

        expect(result).toEqual({
            status: 'unavailable',
            reason: 'loading unavailable; generation unavailable'
        });
        expectTypeOf(result).toEqualTypeOf<ChunkAcquisition<{ id: number }>>();
    });

    it.each([null, undefined])('waits when a ready loader leaves %s loaded lookup', (absent) => {
        const loader: ChunkLoader = { load: () => ({ status: 'ready' }) };
        const generator: TerrainGenerator = {
            generate: () => ({ status: 'failed', reason: 'must not generate after load success' })
        };

        expect(
            acquireChunk<{ id: number } | null | undefined>(
                { x: 1, z: 2 },
                () => absent as { id: number } | null | undefined,
                loader,
                generator
            )
        ).toEqual({ status: 'pending' });
    });

    it.each([null, undefined])('waits when a ready generator leaves %s loaded lookup', (absent) => {
        const loader: ChunkLoader = { load: () => ({ status: 'not-found' }) };
        const generator: TerrainGenerator = { generate: () => ({ status: 'ready' }) };

        expect(
            acquireChunk<{ id: number } | null | undefined>(
                { x: -1, z: 2 },
                () => absent as { id: number } | null | undefined,
                loader,
                generator
            )
        ).toEqual({ status: 'pending' });
    });

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

    it('returns a chunk made available by the generator', () => {
        const chunk = { id: 9 };
        let loaded: typeof chunk | undefined;
        const loader: ChunkLoader = { load: () => ({ status: 'not-found' }) };
        const generator: TerrainGenerator = {
            generate: () => {
                loaded = chunk;
                return { status: 'ready' };
            }
        };

        expect(acquireChunk({ x: 7, z: -8 }, () => loaded, loader, generator)).toEqual({ status: 'ready', chunk });
    });

    it('reports platform stubs as unavailable until loading and generation APIs exist', () => {
        expect(unavailableChunkLoader.load({ x: 0, z: 0 })).toMatchObject({ status: 'unavailable' });
        expect(unavailableTerrainGenerator.generate({ x: 0, z: 0 })).toMatchObject({ status: 'unavailable' });
    });
});
