import type { World } from 'pumpkin:plugin/world@0.1.0';
import { blockStateToInfo } from 'pumpkin:plugin/world@0.1.0';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import {
    acquireChunk,
    type TerrainAccess,
    type TerrainRegion,
    unavailableChunkLoader,
    unavailableTerrainGenerator,
} from '@pumpkin-plugins/terrain';
import { chunkBounds, iterateChunkCoordinates } from '../chunk-coordinates.ts';
import type { Settings } from '../config/schema.ts';

/** Builds the Distant Horizons terrain view while the caller owns the world handle. */
export function createTerrainAccess(world: World, settings: Settings): TerrainAccess {
    const level = world.getName();
    const dimension = world.getDimension();
    const minY = world.getMinY();
    const height =
        settings.worlds[level]?.height ??
        (dimension === 'minecraft:overworld'
            ? 384
            : dimension === 'minecraft:the_nether' || dimension === 'minecraft:the_end'
              ? 256
              : 0);
    let lastColumn = '',
        columnTopY: number | undefined,
        lastId = -1,
        lastMaterial: string | undefined,
        lastBiome = '',
        surfaceBiome: string | undefined;
    const sampleBiomes3d = settings.worlds[level]?.sample_biomes_3d === true;
    const biomeName = (x: number, y: number, z: number) =>
        `minecraft:${world.getBiome({ x, y, z }).replaceAll('-', '_')}`;
    const enterColumn = (x: number, z: number) => {
        const column = `${x}:${z}`;
        if (column === lastColumn) return;
        lastColumn = column;
        columnTopY = undefined;
        surfaceBiome = undefined;
        lastId = -1;
        lastBiome = '';
        lastMaterial = undefined;
    };
    const topBlockY = (x: number, z: number) => {
        enterColumn(x, z);
        if (columnTopY === undefined) columnTopY = world.getTopBlockY(x, z);
        return columnTopY;
    };

    return {
        minY,
        height,
        chunkLoader: unavailableChunkLoader,
        terrainGenerator: unavailableTerrainGenerator,
        prepare: (region: TerrainRegion) => {
            for (const { x, z } of iterateChunkCoordinates(chunkBounds(region))) {
                const result = (() => {
                    try {
                        return acquireChunk(
                            { x, z },
                            () => {
                                // Generated types say undefined for WIT option-none; Static Hermes lifts it as null.
                                const chunk = world.getChunk(x, z);
                                return chunk ?? undefined;
                            },
                            unavailableChunkLoader,
                            unavailableTerrainGenerator,
                        );
                    } catch (err) {
                        // Host world resources can become unavailable while Pumpkin is stopping.
                        return {
                            status: 'unavailable' as const,
                            reason: `Chunk ${x}, ${z} could not be checked: ${String(err)}`,
                        };
                    }
                })();
                if (result.status === 'ready') {
                    disposeWasiResource(result.chunk);
                    continue;
                }
                if (result.status === 'pending') return result;
                return {
                    status: result.status,
                    reason: `Chunk ${x}, ${z} is not loaded: ${result.reason}`,
                };
            }
            return { status: 'ready' };
        },
        top: topBlockY,
        sample: (x, y, z) => {
            const pos = { x, y, z };
            const id = world.getBlockStateId(pos);
            enterColumn(x, z);
            let biome: string;
            if (sampleBiomes3d) {
                biome = biomeName(x, y, z);
            } else {
                if (surfaceBiome === undefined) {
                    const topY = Math.max(minY, Math.min(minY + height - 1, topBlockY(x, z)));
                    surfaceBiome = biomeName(x, topY, z);
                }
                biome = surfaceBiome;
            }
            let material = lastMaterial;
            if (id !== lastId || biome !== lastBiome || material === undefined) {
                const state = blockStateToInfo(id);
                if (!state) throw new Error('Unknown block state');
                const properties = [...state.properties]
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([k, v]) => `{${k}:${v}}`)
                    .join('');
                material = `${biome}_DH-BSW_${state.name}${properties ? `_STATE_${properties}` : ''}`;
                lastId = id;
                lastBiome = biome;
                lastMaterial = material;
            }
            const lightPos = { x, y: Math.min(minY + height - 1, y + 1), z };
            return {
                material,
                skyLight: world.getSkyLight(lightPos),
                blockLight: world.getBlockLight(lightPos),
            };
        },
    };
}
