import * as blocks from 'pumpkin:plugin/world@0.1.0';
import { clientLightStates } from '../lights/client-light.ts';

/** Resolves the client-only Minecraft light states through Pumpkin's block registry. */
export function resolveClientLightStates(): ((level: number) => number) | undefined {
    return clientLightStates((blockName, properties) => blocks.resolveBlockState(blockName, properties));
}
