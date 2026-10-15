import type { Player } from 'pumpkin:plugin/player@0.1.0';
import type { OpManager, Server } from 'pumpkin:plugin/server@0.1.0';
import * as uuid from 'pumpkin:plugin/uuid@0.1.0';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import type { WaypointQueryViewer } from './queries.ts';

/** Runs a resolver while the exact online viewer's Pumpkin resources are alive. */
export function withWaypointViewer<Result>(
    server: Server,
    name: string,
    run: (viewer: WaypointQueryViewer) => Result,
): Result | undefined {
    if (name.length === 0) return undefined;
    const player = server.getPlayerByName(name) ?? undefined;
    if (player === undefined) return undefined;

    let world: ReturnType<Player['getWorld']> | undefined;
    let opManager: OpManager | undefined;
    try {
        if (player.getName() !== name) return undefined;
        const id = player.getId();
        world = player.getWorld();
        opManager = server.getOpManager();
        const [x, y, z] = player.getPosition();
        const viewer: WaypointQueryViewer = {
            dimension: world.getName(),
            isOperator: opManager.isOp(id),
            playerId: uuid.toString(id).toLowerCase(),
            position: { x, y, z },
            yaw: player.getYaw(),
            hasPermission: (node) => player.hasPermission(node),
        };
        return run(viewer);
    } finally {
        releaseResources(opManager, world, player);
    }
}

function releaseResources(...resources: readonly Parameters<typeof disposeWasiResource>[0][]): void {
    let failed = false;
    let firstError: unknown;
    for (const resource of resources) {
        try {
            disposeWasiResource(resource);
        } catch (error) {
            if (!failed) firstError = error;
            failed = true;
        }
    }
    if (failed) throw firstError;
}
