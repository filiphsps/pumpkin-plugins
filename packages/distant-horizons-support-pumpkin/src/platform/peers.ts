import type { Player } from 'pumpkin:plugin/player@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { TextComponent } from 'pumpkin:plugin/text@0.1.0';
import type { Logger } from '@pumpkin-plugins/plugin-kit/logger';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import type { Settings } from '../config/schema.ts';
import { PLUGIN_NAME } from '../name.ts';
import { CHANNEL } from '../protocol/messages.ts';
import type { Peer, Peers } from '../session.ts';
import { createTerrainAccess } from './terrain-access.ts';

/** Creates terrain access from current player handles, and releases every acquired resource. */
export function withPlayer(player: Player, settings: Settings, use: (peer: Peer) => void): boolean {
    const java = player.asJava();
    if (!java) return false;
    let world: ReturnType<typeof player.getWorld> | undefined;
    let border: ReturnType<NonNullable<typeof world>['getWorldBorder']> | undefined;
    try {
        world = player.getWorld();
        const level = world.getName(),
            dimension = world.getDimension(),
            position = player.getPosition();
        if (!/^(?=.{1,150}$)([a-zA-Z0-9_-]+@)?[a-zA-Z0-9_-]+(:[a-zA-Z0-9_-]+)?$/.test(level))
            throw new Error('World name is not a valid DH level key');
        border = world.getWorldBorder();
        const borderX = border.getCenterX(),
            borderZ = border.getCenterZ(),
            radius = border.getSize() / 2;
        const terrain = createTerrainAccess(world, settings);
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
