import { describe, expect, it } from 'vitest';
import { applyBlocks } from './blocks.ts';

const readme = '# T\n\nIntro prose.\n\n<!-- docs:begin commands -->\nold\n<!-- docs:end commands -->\n\nMore prose.\n';

describe('applyBlocks', () => {
    it('rejects unbalanced or duplicated markers', () => {
        expect(() => applyBlocks('<!-- docs:begin commands -->\n', { commands: 'X' }, 'R.md')).toThrow(/exactly one/);
        expect(() => applyBlocks(`${readme}${readme}`, { commands: 'X' }, 'R.md')).toThrow(/found 2 and 2/);
    });

    it('rejects markers in the wrong order', () => {
        expect(() =>
            applyBlocks('<!-- docs:end commands -->\n<!-- docs:begin commands -->', { commands: 'X' }, 'R.md'),
        ).toThrow(/comes before/);
    });

    it('uses the note it is given', () => {
        expect(applyBlocks(readme, { commands: 'NEW' }, 'README.md', '<!-- hi -->')).toContain('<!-- hi -->');
    });
});

it('requires configured blocks and validates legacy action marker pairs', () => {
    expect(() => applyBlocks('No markers', { facts: 'New' }, 'guide.md', '', { required: true })).toThrow(
        'docs:begin facts',
    );
    const text = 'Intro\n<!-- action-inputs:start -->\nold\n<!-- action-inputs:end -->\nUsage';
    expect(applyBlocks(text, { inputs: 'New' }, 'R.md', '', { markers: 'action', required: true })).toBe(
        'Intro\n<!-- action-inputs:start -->\nNew\n<!-- action-inputs:end -->\nUsage',
    );
    expect(() => applyBlocks(`${text}${text}`, { inputs: 'New' }, 'R.md', '', { markers: 'action' })).toThrow(
        'found 2 and 2',
    );
});
