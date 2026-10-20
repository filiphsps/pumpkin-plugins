import { describe, expect, it } from 'vitest';
import { PUMPKIN_RELEASE_SHA256 } from './pumpkin-version.ts';
import { assetName, deepMerge, parseChecksums } from './util.ts';

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
    it('picks the musl build on musl Linux only', () => {
        expect(assetName('linux', 'x64', true)).toBe('pumpkin-X64-Linux-musl');
        expect(assetName('linux', 'arm64', true)).toBe('pumpkin-ARM64-Linux-musl');
        expect(assetName('darwin', 'arm64', true)).toBe('pumpkin-ARM64-macOS');
    });
    it('names only assets with a pinned checksum', () => {
        const hosts = [
            ['darwin', 'arm64', false],
            ['linux', 'x64', false],
            ['linux', 'x64', true],
            ['linux', 'arm64', false],
            ['linux', 'arm64', true],
            ['win32', 'x64', false],
            ['win32', 'arm64', false],
        ] as const;
        for (const [platform, arch, musl] of hosts) {
            expect(PUMPKIN_RELEASE_SHA256[assetName(platform, arch, musl)]).toMatch(/^[0-9a-f]{64}$/);
        }
    });
    it('tells the user about PUMPKIN_BIN for unsupported ones', () => {
        expect(() => assetName('darwin', 'x64')).toThrow(/PUMPKIN_BIN/);
    });
});

describe('parseChecksums', () => {
    it('reads sha256sum lines', () => {
        const sums = parseChecksums(
            `${'a'.repeat(64)}  pumpkin-X64-Linux\n${'B'.repeat(64)} *pumpkin-ARM64-macOS\nnot a line\n`,
        );
        expect(sums.get('pumpkin-X64-Linux')).toBe('a'.repeat(64));
        expect(sums.get('pumpkin-ARM64-macOS')).toBe('b'.repeat(64));
        expect(sums.size).toBe(2);
    });
});
