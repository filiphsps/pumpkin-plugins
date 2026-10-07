import { describe, expect, it } from 'vitest';
import { minecraft } from './index.ts';

describe('Minecraft string formatting', () => {
    it('returns legacy codes that can be embedded in a message string', () => {
        expect(`Memory cache: ${minecraft.aqua('100 B')}`).toBe('Memory cache: §b100 B§r');
    });

    it('combines a color and modifiers in canonical order', () => {
        expect(minecraft.red.bold.underline('Warning')).toBe('§c§l§nWarning§r');
        expect(minecraft.underline.bold.red('Warning')).toBe('§c§l§nWarning§r');
    });

    it('uses the last color in a style chain', () => {
        expect(minecraft.red.blue('Info')).toBe('§9Info§r');
    });

    it('formats RGB colors with the Minecraft section-sign notation', () => {
        expect(minecraft.hex('#12aBcD').italic('Custom')).toBe('§x§1§2§a§b§c§d§oCustom§r');
    });

    it('rejects hex colors that are not six hexadecimal digits', () => {
        expect(() => minecraft.hex('#12abc')).toThrow('Expected a six-digit hex color');
    });

    it('leaves text unchanged when no style is selected', () => {
        expect(minecraft('Plain')).toBe('Plain');
    });
});
