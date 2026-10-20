import type { Player } from 'pumpkin:plugin/player@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { TextComponent } from 'pumpkin:plugin/text@0.1.0';
import { blockStateToInfo } from 'pumpkin:plugin/world@0.1.0';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import type { TerrainAccess, TerrainRegion } from '@pumpkin-plugins/terrain';
import type { Settings } from '../config/schema.ts';
import { CHUNK_SIZE_BLOCKS } from '../protocol/constants.ts';
import { CHANNEL } from '../protocol/messages.ts';
import type { Peer, Peers, PlayerTerrain } from '../session.ts';

type Handle = Parameters<typeof disposeWasiResource>[0];
type JavaPlayer = NonNullable<ReturnType<Player['asJava']>>;

/** Creates DH session access for a Java player, returning false for players without a Java handle. */
export function withPlayer(player: Player, settings: Settings, use: (peer: Peer) => void): boolean {
    const java = player.asJava();
    if (!java) return false;
    try {
        withPlayerTerrain(player, settings, (peer) => use(sessionPeer(peer, java)));
        return true;
    } finally {
        disposeWasiResource(java);
    }
}

/** Creates terrain and chat access for any player, and releases every acquired resource. */
export function withPlayerTerrain(player: Player, settings: Settings, use: (peer: PlayerTerrain) => void): void {
    const handles: Handle[] = [];
    try {
        use(openPlayerTerrain(player, settings, handles));
    } finally {
        release(handles);
    }
}

/** Builds terrain and chat access for a player, adding each world handle it acquires to `handles`. */
function openPlayerTerrain(player: Player, settings: Settings, handles: Handle[]): PlayerTerrain {
    const world = held(handles, player.getWorld());
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
    const border = held(handles, world.getWorldBorder());
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
                    // The pinned API can only read loaded chunks; it cannot load saved ones or generate new ones.
                    let chunk: ReturnType<typeof world.getChunk>;
                    try {
                        chunk = world.getChunk(x, z);
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
    return {
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
        borderBounds: {
            minX: borderX - radius,
            maxX: borderX + radius,
            minZ: borderZ - radius,
            maxZ: borderZ + radius,
        },
        insideBorder: (x, z) => Math.abs(x + 0.5 - borderX) <= radius && Math.abs(z + 0.5 - borderZ) <= radius,
        terrain,
    };
}

/**
 * Resolves connected players for one server tick. The first call for a player acquires its host
 * handles; later calls reuse them until the peers are disposed, so one tick looks each player up
 * once. Callback errors reach the caller.
 */
export function serverPeers(server: Server, settings: Settings): Peers & Disposable {
    const handles: Handle[] = [];
    const players = new Map<string, Player | undefined>();
    const terrains = new Map<string, PlayerTerrain>();
    const javaPeers = new Map<string, Peer | undefined>();
    const playerNamed = (name: string): Player | undefined => {
        if (!players.has(name)) players.set(name, held(handles, server.getPlayerByName(name) ?? undefined));
        return players.get(name);
    };
    const terrainOf = (name: string, player: Player): PlayerTerrain => {
        const terrain = terrains.get(name) ?? openPlayerTerrain(player, settings, handles);
        terrains.set(name, terrain);
        return terrain;
    };
    return {
        withPeer: (name, use) => {
            const player = playerNamed(name);
            if (!player) return false;
            if (!javaPeers.has(name)) {
                const java = held(handles, player.asJava() ?? undefined);
                javaPeers.set(name, java && sessionPeer(terrainOf(name, player), java));
            }
            const peer = javaPeers.get(name);
            if (!peer) return false;
            use(peer);
            return true;
        },
        withTerrain: (name, use) => {
            const player = playerNamed(name);
            if (!player) return false;
            use(terrainOf(name, player));
            return true;
        },
        [Symbol.dispose]: () => release(handles),
    };
}

function sessionPeer(peer: PlayerTerrain, java: JavaPlayer): Peer {
    return { ...peer, send: (bytes) => java.sendCustomPayload(CHANNEL, bytes) };
}

function held<T extends Handle>(handles: Handle[], handle: T): T {
    handles.push(handle);
    return handle;
}

/** Releases handles in reverse order of acquisition. */
function release(handles: Handle[]): void {
    while (handles.length > 0) disposeWasiResource(handles.pop());
}
