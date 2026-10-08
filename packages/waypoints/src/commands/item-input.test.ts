import { describe, expect, it } from 'vitest';
import { itemIconInputFromCommand } from './item-input.ts';

describe('item icon command input', () => {
    it.each([
        ['wp set icon Pumpkin minecraft:pumpkin_pie', 'minecraft:pumpkin_pie'],
        ['/wp set icon Pumpkin pumpkin_pie', 'pumpkin_pie'],
        ['wp set icon "Bert the Great" minecraft:golden_apple', 'minecraft:golden_apple']
    ])('extracts the item identifier from %j', (command, expected) => {
        expect(itemIconInputFromCommand(command)).toBe(expected);
    });

    it.each(['wp set color Pumpkin 00ff00', 'wp set icon Pumpkin', 'other wp set icon Pumpkin stone'])(
        'ignores unrelated or incomplete command input %j',
        (command) => {
            expect(itemIconInputFromCommand(command)).toBeUndefined();
        }
    );
});
