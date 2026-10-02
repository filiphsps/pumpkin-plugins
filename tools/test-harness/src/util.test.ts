import { describe, expect, it } from 'vitest';
import { assetName, deepMerge, parseChecksums, stripAnsi } from './util.ts';

describe('deepMerge', () => {
    it('merges nested objects and lets the override win', () => {
        const merged = deepMerge({ a: { x: 1, y: 2 }, list: [1], keep: true }, { a: { y: 3 }, list: [2, 3] });
        expect(merged).toEqual({ a: { x: 1, y: 3 }, list: [2, 3], keep: true });
    });
});

describe('assetName', () => {
    it('maps supported platforms', () => {
        expect(assetName('darwin', 'arm64')).toBe('pumpkin-ARM64-macOS');
        expect(assetName('linux', 'x64')).toBe('pumpkin-X64-Linux');
        expect(assetName('win32', 'x64')).toBe('pumpkin-X64-Windows.exe');
    });
    it('tells the user about PUMPKIN_BIN for unsupported ones', () => {
        expect(() => assetName('darwin', 'x64')).toThrow(/PUMPKIN_BIN/);
    });
});

describe('parseChecksums', () => {
    it('reads sha256sum lines', () => {
        const sums = parseChecksums(
            `${'a'.repeat(64)}  pumpkin-X64-Linux\n${'B'.repeat(64)} *pumpkin-ARM64-macOS\nnot a line\n`
        );
        expect(sums.get('pumpkin-X64-Linux')).toBe('a'.repeat(64));
        expect(sums.get('pumpkin-ARM64-macOS')).toBe('b'.repeat(64));
        expect(sums.size).toBe(2);
    });
});

describe('stripAnsi', () => {
    it('removes color codes', () => {
        expect(stripAnsi('\x1b[2m20:59:23\x1b[0m \x1b[32m INFO\x1b[0m hi')).toBe('20:59:23  INFO hi');
    });
});
