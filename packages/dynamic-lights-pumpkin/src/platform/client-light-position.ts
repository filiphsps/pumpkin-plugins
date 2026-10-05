import type { World } from 'pumpkin:plugin/world@0.1.0';
import { type BlockPosition, findLightPosition } from '../lights/client-light.ts';

/** Finds a safe client-light position without visually replacing a real block. */
export function findClientLightPosition(world: World, position: BlockPosition): BlockPosition | undefined {
    return findLightPosition(position, (candidate) => world.getBlockState(candidate).isAir);
}
