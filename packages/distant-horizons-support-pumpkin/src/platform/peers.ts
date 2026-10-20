import type { Player } from 'pumpkin:plugin/player@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { TextComponent } from 'pumpkin:plugin/text@0.1.0';
import { blockStateToInfo } from 'pumpkin:plugin/world@0.1.0';
import type { Logger } from '@pumpkin-plugins/plugin-kit/logger';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import type { TerrainAccess, TerrainRegion } from '@pumpkin-plugins/terrain';
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
            columnTopY: number | undefined,
            lastId = -1,
            lastMaterial: string | undefined,
            lastBiome = '',
            surfaceBiome: string | undefined;
        const sampleBiomes3d = settings.worlds[level]?.sample_biomes_3d === true;
        const biomeName = (x: number, y: number, z: number) =>
            `minecraft:${terrainWorld.getBiome({ x, y, z }).replaceAll('-', '_')}`;
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
            if (columnTopY === undefined) columnTopY = terrainWorld.getTopBlockY(x, z);
            return columnTopY;
        };
        const terrain: TerrainAccess = {
            minY,
            height,
            prepare: (region: TerrainRegion) => {
                const firstChunkX = Math.floor(region.originX / CHUNK_SIZE_BLOCKS);
                const lastChunkX = Math.floor((region.originX + region.width - 1) / CHUNK_SIZE_BLOCKS);
                const firstChunkZ = Math.floor(region.originZ / CHUNK_SIZE_BLOCKS);
                const lastChunkZ = Math.floor((region.originZ + region.depth - 1) / CHUNK_SIZE_BLOCKS);
                for (let x = firstChunkX; x <= lastChunkX; x++) {
                    for (let z = firstChunkZ; z <= lastChunkZ; z++) {
                        let chunk: ReturnType<typeof terrainWorld.getChunk>;
                        try {
                            chunk = terrainWorld.getChunk(x, z);
                        } catch (err) {
                            // Host world resources can become unavailable while Pumpkin is stopping.
                            return {
                                status: 'unavailable',
                                reason: `Chunk ${x}, ${z} could not be checked: ${String(err)}`,
                            };
                        }
                        // Generated types say undefined for WIT option-none; Static Hermes lifts it as null.
                        if (!chunk) return { status: 'unavailable', reason: `Chunk ${x}, ${z} is not loaded` };
                        disposeWasiResource(chunk);
                    }
                }
                return { status: 'ready' };
            },
            top: topBlockY,
            sample: (x, y, z) => {
                const pos = { x, y, z };
                const id = terrainWorld.getBlockStateId(pos);
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
                    skyLight: terrainWorld.getSkyLight(lightPos),
                    blockLight: terrainWorld.getBlockLight(lightPos),
                };
            },
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
                maxZ: borderZ + radius,
            },
            insideBorder: (x, z) => Math.abs(x + 0.5 - borderX) <= radius && Math.abs(z + 0.5 - borderZ) <= radius,
            terrain,
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
        },
    };
}
