import type { BlockGrowEventData, BlockSpreadEventData } from 'pumpkin:plugin/event@0.1.0';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import type { Sessions } from '../session.ts';

type MutationWorld = BlockGrowEventData['targetWorld'];
type MutationPosition = { x: number; z: number };
type MutationSessions = Pick<Sessions, 'changedMany'>;

/** Invalidates a grown position when Pumpkin accepts its growth event. */
export function invalidateBlockGrow(sessions: MutationSessions, event: BlockGrowEventData): void {
    invalidateMutation(sessions, event.targetWorld, [{ x: event.blockPos.x, z: event.blockPos.z }], event.cancelled);
}

/** Invalidates the changed target of an accepted Pumpkin spread event. */
export function invalidateBlockSpread(sessions: MutationSessions, event: BlockSpreadEventData): void {
    invalidateMutation(sessions, event.targetWorld, [{ x: event.targetPos.x, z: event.targetPos.z }], event.cancelled);
}

function invalidateMutation(
    sessions: MutationSessions,
    world: MutationWorld,
    positions: readonly MutationPosition[],
    cancelled: boolean
): void {
    try {
        if (!cancelled) sessions.changedMany(world.getName(), positions);
    } finally {
        disposeWasiResource(world);
    }
}
