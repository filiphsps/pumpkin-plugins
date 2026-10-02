import { describe, expect, it } from 'vitest';
import { applyBlocks } from './blocks.ts';

const readme = '# T\n\nIntro prose.\n\n<!-- docs:begin commands -->\nold\n<!-- docs:end commands -->\n\nMore prose.\n';

describe('applyBlocks', () => {
    it('replaces only the marked block and keeps the prose', () => {
        const out = applyBlocks(readme, { commands: 'NEW' }, 'README.md');
        expect(out).toContain('Intro prose.');
        expect(out).toContain('More prose.');
        expect(out).toContain('<!-- docs:begin commands -->\n<!-- Generated');
        expect(out).toContain('\n\nNEW\n<!-- docs:end commands -->');
        expect(out).not.toContain('old');
    });

    it('is idempotent', () => {
        const once = applyBlocks(readme, { commands: 'NEW' }, 'README.md');
        expect(applyBlocks(once, { commands: 'NEW' }, 'README.md')).toBe(once);
    });

    it('skips blocks the README does not mark', () => {
        expect(applyBlocks(readme, { config: 'X' }, 'README.md')).toBe(readme);
    });

    it('rejects unbalanced or duplicated markers', () => {
        expect(() => applyBlocks('<!-- docs:begin commands -->\n', { commands: 'X' }, 'R.md')).toThrow(/exactly one/);
        expect(() => applyBlocks(`${readme}${readme}`, { commands: 'X' }, 'R.md')).toThrow(/found 2 and 2/);
    });

    it('rejects markers in the wrong order', () => {
        expect(() =>
            applyBlocks('<!-- docs:end commands -->\n<!-- docs:begin commands -->', { commands: 'X' }, 'R.md')
        ).toThrow(/comes before/);
    });

    it('uses the note it is given', () => {
        expect(applyBlocks(readme, { commands: 'NEW' }, 'README.md', '<!-- hi -->')).toContain('<!-- hi -->');
    });
});
