import { describe, expect, it } from 'vitest';
import { cell, code, table } from './markdown.ts';

describe('markdown helpers', () => {
    it('keeps a table cell on one line and escapes pipes', () => {
        expect(cell('a | b\n   c')).toBe('a \\| b c');
        expect(cell('a\n \n b')).toBe('a b');
    });

    it('renders a table with a separator row', () => {
        expect(table(['A', 'B'], [['1', 'x|y']])).toBe('| A | B |\n| --- | --- |\n| 1 | x\\|y |');
    });
});

it('escapes table headers and preserves requested multiline cells', () => {
    expect(table(['A|B'], [['first\r\nsecond']], { multiline: 'break' })).toBe(
        '| A\\|B |\n| --- |\n| first<br>second |',
    );
    expect(code('`value`')).toBe('`` `value` ``');
    expect(code(' a ')).toBe('`  a  `');
});
