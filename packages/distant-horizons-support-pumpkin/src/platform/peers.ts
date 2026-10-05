import type { Player } from 'pumpkin:plugin/player@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { blockStateToInfo, type Chunk } from 'pumpkin:plugin/world@0.1.0';
import type { Logger } from '@pumpkin-plugins/plugin-kit/logger';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import type { Settings } from '../config/schema.ts';
import type { Sample } from '../lod/builder.ts';
import { CHANNEL } from '../protocol/messages.ts';
import type { Peer, Peers } from '../session.ts';

/** Creates terrain access from current player handles, and releases every acquired resource. */
export function withPlayer(player: Player, settings: Settings, use: (peer: Peer) => void): boolean {
    const java = player.asJava();
    if (!java) return false;
    let world: ReturnType<typeof player.getWorld> | undefined;
    const chunks = new Map<string, Chunk>();
    let border: ReturnType<NonNullable<typeof world>['getWorldBorder']> | undefined;
    try {
        world = player.getWorld();
        const terrainWorld = world;
        const level = world.getName(),
            dimension = world.getDimension(),
            position = player.getPosition();
        if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(level)) throw new Error('World name is not a valid DH level key');
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
            lastSample: Sample | undefined,
            biome = '';
        use({
            name: player.getName(),
            level,
            dimension,
            x: position[0],
            z: position[2],
            send: (bytes) => java.sendCustomPayload(CHANNEL, bytes),
            insideBorder: (x, z) => Math.abs(x + 0.5 - borderX) <= radius && Math.abs(z + 0.5 - borderZ) <= radius,
            terrain: {
                minY,
                height,
                sample: (x, y, z) => {
                    const chunkX = Math.floor(x / 16),
                        chunkZ = Math.floor(z / 16),
                        key = `${chunkX}:${chunkZ}`;
                    let chunk = chunks.get(key);
                    if (!chunk) {
                        chunk = terrainWorld.getChunk(chunkX, chunkZ);
                        if (!chunk) throw new Error('Chunk is not loaded');
                        chunks.set(key, chunk);
                    }
                    const pos = { x: x - chunkX * 16, y, z: z - chunkZ * 16 },
                        column = `${x}:${z}`;
                    const id = chunk.getBlockStateId(pos);
                    if (column !== lastColumn) {
                        biome = `minecraft:${chunk.getBiome({ ...pos, y: Math.max(minY, Math.min(minY + height - 1, chunk.getTopBlockY(pos.x, pos.z))) }).replaceAll('-', '_')}`;
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
                    const mapping = `${biome}_DH-BSW_${state.name}${properties ? `_STATE_${properties}` : ''}`;
                    const lightPos = { ...pos, y: Math.min(minY + height - 1, y + 1) };
                    lastId = id;
                    lastSample = { mapping, sky: chunk.getSkyLight(lightPos), block: chunk.getBlockLight(lightPos) };
                    return lastSample;
                }
            }
        });
        return true;
    } finally {
        for (const chunk of chunks.values()) disposeWasiResource(chunk);
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
                log.warn(`DistantHorizonsSupportPumpkin: cannot access player terrain: ${String(err)}`);
                return false;
            } finally {
                disposeWasiResource(player);
            }
        }
    };
}
