import type { World } from 'pumpkin:plugin/world@0.1.0';
import type { BlockPosition } from '../lights/client-light.ts';
import type { LightRecoveryWorld } from '../lights/journal.ts';

/** Adapts Pumpkin's world resource to the operations used by legacy-light recovery. */
export class PumpkinLightWorld implements LightRecoveryWorld {
    readonly id: string;

    constructor(private readonly world: World) {
        this.id = world.getId();
    }

    /** Reads the current temporary-capable block-light level. */
    getBlockLight(position: BlockPosition): number {
        return this.world.getBlockLight(position);
    }

    /** Sets light without replacing the block at this position. */
    setBlockLight(position: BlockPosition, level: number): void {
        this.world.setBlockLight(position, level);
    }
}
