import type { Player } from 'pumpkin:plugin/player@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { TextComponent } from 'pumpkin:plugin/text@0.1.0';
import { blockStateToInfo } from 'pumpkin:plugin/world@0.1.0';
import type { Logger } from '@pumpkin-plugins/plugin-kit/logger';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import {
    acquireChunk,
    type TerrainAccess,
    type TerrainRegion,
    type TerrainSample,
    unavailableChunkLoader,
    unavailableTerrainGenerator
} from '@pumpkin-plugins/terrain';
import type { Settings } from '../config/schema.ts';
import { PLUGIN_NAME } from '../name.ts';
import { CHUNK_SIZE_BLOCKS } from '../protocol/constants.ts';
import { CHANNEL } from '../protocol/messages.ts';
import type { Peer, Peers } from '../session.ts';

/** Creates terrain access from current player handles, and releases every acquired resource. */
export function withPlayer(player: Player, settings: Settings, use: (peer: Peer) => void): boolean {
    const java = player.asJava();
    if (!java) return false;
    let world: ReturnType<typeof player.getWorld> | undefined;
    const chunkLoader = unavailableChunkLoader;
    const terrainGenerator = unavailableTerrainGenerator;
    let border: ReturnType<NonNullable<typeof world>['getWorldBorder']> | undefined;
    try {
        world = player.getWorld();
        const terrainWorld = world;
        const level = world.getName(),
            dimension = world.getDimension(),
            position = player.getPosition();
        if (!/^(?=.{1,150}$)([a-zA-Z0-9_-]+@)?[a-zA-Z0-9_-]+(:[a-zA-Z0-9_-]+)?$/.test(level))
            throw new Error('World name is not a valid DH level key');
        const minY = world.getMinY();
        const height =
            settings.worlds[level]?.height ??
            (dimension === 'minecraft:overworld'
                ? 384
                : dimension === 'minecraft:the_nether' || dimension === 'minecraft:the_end'
                  ? 256
                  : 0);
        border = world.getWorldBorder();
        const borderX = border.getCenterX(),
            borderZ = border.getCenterZ(),
            radius = border.getSize() / 2;
        let lastColumn = '',
            lastId = -1,
            lastSample: TerrainSample | undefined,
            biome = '';
        const terrain: TerrainAccess = {
            minY,
            height,
            chunkLoader,
            terrainGenerator,
            prepare: (region: TerrainRegion) => {
                const firstChunkX = Math.floor(region.originX / CHUNK_SIZE_BLOCKS);
                const lastChunkX = Math.floor((region.originX + region.width - 1) / CHUNK_SIZE_BLOCKS);
                const firstChunkZ = Math.floor(region.originZ / CHUNK_SIZE_BLOCKS);
                const lastChunkZ = Math.floor((region.originZ + region.depth - 1) / CHUNK_SIZE_BLOCKS);
                for (let x = firstChunkX; x <= lastChunkX; x++) {
                    for (let z = firstChunkZ; z <= lastChunkZ; z++) {
                        const result = acquireChunk(
                            { x, z },
                            () => {
                                // Generated types say undefined for WIT option-none; QuickJS lifts it as null.
                                const chunk = terrainWorld.getChunk(x, z);
                                return chunk ?? undefined;
                            },
                            chunkLoader,
                            terrainGenerator
                        );
                        if (result.status === 'ready') {
                            disposeWasiResource(result.chunk);
                            continue;
                        }
                        if (result.status === 'pending') return result;
                        return {
                            status: result.status,
                            reason: `Chunk ${x}, ${z} is not loaded: ${result.reason}`
                        };
                    }
                }
                return { status: 'ready' };
            },
            top: (x, z) => terrainWorld.getTopBlockY(x, z),
            sample: (x, y, z) => {
                const pos = { x, y, z },
                    column = `${x}:${z}`;
                const id = terrainWorld.getBlockStateId(pos);
                if (column !== lastColumn) {
                    const topY = Math.max(minY, Math.min(minY + height - 1, terrainWorld.getTopBlockY(x, z)));
                    biome = `minecraft:${terrainWorld.getBiome({ ...pos, y: topY }).replaceAll('-', '_')}`;
                    lastId = -1;
                    lastColumn = column;
                }
                if (id === lastId && lastSample) return lastSample;
                const state = blockStateToInfo(id);
                if (!state) throw new Error('Unknown block state');
                const properties = [...state.properties]
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([k, v]) => `{${k}:${v}}`)
                    .join('');
                const material = `${biome}_DH-BSW_${state.name}${properties ? `_STATE_${properties}` : ''}`;
                const lightPos = { x, y: Math.min(minY + height - 1, y + 1), z };
                lastId = id;
                lastSample = {
                    material,
                    skyLight: terrainWorld.getSkyLight(lightPos),
                    blockLight: terrainWorld.getBlockLight(lightPos)
                };
                return lastSample;
            }
        };
        use({
            name: player.getName(),
            level,
            dimension,
            x: position[0],
            z: position[2],
            report: (message) => {
                const component = TextComponent.text(message);
                try {
                    player.sendSystemMessage(component, false);
                } finally {
                    disposeWasiResource(component);
                }
            },
            send: (bytes) => java.sendCustomPayload(CHANNEL, bytes),
            borderBounds: {
                minX: borderX - radius,
                maxX: borderX + radius,
                minZ: borderZ - radius,
                maxZ: borderZ + radius
            },
            insideBorder: (x, z) => Math.abs(x + 0.5 - borderX) <= radius && Math.abs(z + 0.5 - borderZ) <= radius,
            terrain
        });
        return true;
    } finally {
        disposeWasiResource(border);
        disposeWasiResource(world);
        disposeWasiResource(java);
    }
}

/** Resolves connected Java players afresh for each tick, without retaining host handles. */
export function serverPeers(server: Server, settings: Settings, log: Logger): Peers {
    return {
        withPeer: (name, use) => {
            const player = server.getPlayerByName(name);
            if (!player) return false;
            try {
                return withPlayer(player, settings, use);
            } catch (err) {
                log.warn(`${PLUGIN_NAME}: cannot access player terrain: ${String(err)}`);
                return false;
            } finally {
                disposeWasiResource(player);
            }
        }
    };
}
