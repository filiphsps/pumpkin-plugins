import type { Player } from 'pumpkin:plugin/player@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { TextComponent } from 'pumpkin:plugin/text@0.1.0';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import type { Settings } from '../config/schema.ts';
import { CHANNEL } from '../protocol/messages.ts';
import type { Peer, Peers, PlayerTerrain } from '../session.ts';
import { createTerrainAccess } from './terrain-access.ts';

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
    const border = held(handles, world.getWorldBorder());
    const borderX = border.getCenterX(),
        borderZ = border.getCenterZ(),
        radius = border.getSize() / 2;
    const terrain = createTerrainAccess(world, settings);
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
