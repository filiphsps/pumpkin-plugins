import { stripVTControlCharacters } from 'node:util';

/**
 * Checks whether Vitest reports the complete native real-server suite as passing.
 */
export function hasPassingVitestSummary(output) {
    const plainOutput = stripVTControlCharacters(output);
    return /Test Files\s+2 passed\s+\(2\)/.test(plainOutput) && /Tests\s+6 passed\s+\(6\)/.test(plainOutput);
}
