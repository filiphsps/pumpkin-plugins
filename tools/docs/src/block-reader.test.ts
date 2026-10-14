import { expect, it } from 'vitest';
import { generatedBlocks, stripGeneratedBlocks } from './block-reader.ts';

it('finds both marker syntaxes with source offsets and strips only generated content', () => {
    const source =
        'Intro\n<!-- docs:begin one -->\nGen\n<!-- docs:end one -->\nHandwritten\n<!-- action-inputs:start -->\nTable\n<!-- action-inputs:end -->\nOutro';
    const blocks = generatedBlocks(source);
    expect(blocks.map(({ name, markers }) => ({ name, markers }))).toEqual([
        { name: 'one', markers: 'docs' },
        { name: 'inputs', markers: 'action' },
    ]);
    expect(blocks[0].start).toBe(6);
    expect(blocks[0].end).toBe(55);
    expect(blocks[0].text).toBe('<!-- docs:begin one -->\nGen\n<!-- docs:end one -->');
    expect(stripGeneratedBlocks(source)).toBe('Intro\n\nHandwritten\n\nOutro');
});

it('accepts spaced markers but leaves unrelated comments and incomplete pairs intact', () => {
    const source =
        '<!--  DOCS:begin facts  -->body<!-- DOCS:end facts -->\n<!-- manual -->\n<!-- docs:begin unfinished -->';
    expect(stripGeneratedBlocks(source)).toBe('\n<!-- manual -->\n<!-- docs:begin unfinished -->');
});
