import { readTarget } from '../../../scripts/pumpkin-targets.mjs';

/** The default release pin; runtime selection is resolved per invocation in binary.ts. */
export const PUMPKIN_RELEASE = readTarget(undefined, 'release').server.tag;
