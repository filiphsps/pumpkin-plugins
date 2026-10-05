import { describe, expect, it } from 'vitest';
import { colorLogValue } from './logger.ts';

describe('colorLogValue', () => {
    it.each([
        ['cyan', 36],
        ['green', 32],
        ['yellow', 33]
    ] as const)('wraps the value in Pumpkin’s %s console color', (color, code) => {
        expect(colorLogValue('value', color)).toBe(`\u001b[${code}mvalue\u001b[0m`);
    });
});
