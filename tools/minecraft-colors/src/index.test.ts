import { describe, expect, it } from 'vitest';
import { color, colorTable } from './index.ts';

describe('Minecraft string formatting', () => {
    it('returns legacy codes that can be embedded in a message string', () => {
        expect(`Memory cache: ${color.aqua('100 B')}`).toBe('Memory cache: §b100 B§r');
    });

    it('combines a color and modifiers in canonical order', () => {
        expect(color.red.bold.underline('Warning')).toBe('§c§l§nWarning§r');
        expect(color.underline.bold.red('Warning')).toBe('§c§l§nWarning§r');
    });

    it('uses the last color in a style chain', () => {
        expect(color.red.blue('Info')).toBe('§9Info§r');
    });

    it('formats RGB colors with the Minecraft section-sign notation', () => {
        expect(color.hex('#12aBcD').italic('Custom')).toBe('§x§1§2§a§b§c§d§oCustom§r');
    });

    it('rejects hex colors that are not six hexadecimal digits', () => {
        expect(() => color.hex('#12abc')).toThrow('Expected a six-digit hex color');
    });

    it('leaves text unchanged when no style is selected', () => {
        expect(color('Plain')).toBe('Plain');
    });

    it('formats values by their semantic role', () => {
        expect(color.named.value('42')).toBe('§642§r');
        expect(color.named.name('Pumpkin')).toBe('§3Pumpkin§r');
        expect(color.named.namespace('minecraft')).toBe('§2minecraft§r');
        expect(color.named.version('1.2.3')).toBe('§a1.2.3§r');
        expect(color.named.url('https://example.test')).toBe('§3https://example.test§r');
        expect(color.named.permission('plugin.manage')).toBe('§e§lplugin.manage§r');
        expect(color.named.port('8123')).toBe('§e8123§r');
        expect(color.named.uuid('1234')).toBe('§e1234§r');
        expect(color.named.identifier('minecraft:stone')).toBe('§eminecraft:stone§r');
    });

    it('returns a table with each legacy color shown normally and in bold', () => {
        const colors = [
            ['black', '0'],
            ['darkBlue', '1'],
            ['darkGreen', '2'],
            ['darkAqua', '3'],
            ['darkRed', '4'],
            ['darkPurple', '5'],
            ['gold', '6'],
            ['gray', '7'],
            ['darkGray', '8'],
            ['blue', '9'],
            ['green', 'a'],
            ['aqua', 'b'],
            ['red', 'c'],
            ['lightPurple', 'd'],
            ['yellow', 'e'],
            ['white', 'f']
        ];
        const nameWidth = 11;
        const lines = colorTable().split('\n');

        expect(lines).toHaveLength(colors.length + 2);
        expect(lines[0]).toBe('Color       | Bold');
        expect(lines[1]).toBe('------------+------------');
        expect(lines.slice(2)).toEqual(
            colors.map(([name, code]) => {
                const padding = ' '.repeat(nameWidth - name.length);
                return `§${code}${name}§r${padding} | §${code}§l${name}§r`;
            })
        );
    });
});
