import { describe, expect, it } from 'vitest';
import { cell, code, table } from './markdown.ts';

describe('markdown helpers', () => {
    it('keeps a table cell on one line and escapes pipes', () => {
        expect(cell('a | b\n   c')).toBe('a \\| b c');
    });

    it('renders a table with a separator row', () => {
        expect(table(['A', 'B'], [['1', 'x|y']])).toBe('| A | B |\n| --- | --- |\n| 1 | x\\|y |');
    });

    it('wraps text as inline code', () => {
        expect(code('fs.read.data')).toBe('`fs.read.data`');
    });
});
