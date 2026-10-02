import { describe, expect, it } from 'vitest';
import type { PackEntry } from '../packs/entries.ts';
import { formatSize, listLines, reloadLines } from './format.ts';

const entry = (over: Partial<PackEntry> = {}): PackEntry => ({
    fileName: 'a.mcpack',
    path: 'packs/a.mcpack',
    uuid: '627409cd-5207-46f1-b1e8-0d4492616419',
    version: '1.0.1',
    size: 5184225,
    downloadUrl: 'http://127.0.0.1:8123/packs/a.mcpack',
    order: 0,
    addonPack: false,
    hasScripts: false,
    rtxEnabled: false,
    ...over
});

describe('formatSize', () => {
    it('uses the largest unit that keeps the number above 1', () => {
        expect(formatSize(0)).toBe('0 B');
        expect(formatSize(1023)).toBe('1023 B');
        expect(formatSize(1024)).toBe('1.0 KiB');
        expect(formatSize(5184225)).toBe('4.9 MiB');
        expect(formatSize(3 * 1024 ** 3)).toBe('3.0 GiB');
        expect(formatSize(5000 * 1024 ** 3)).toBe('5000.0 GiB');
    });
});

describe('listLines', () => {
    it('says when there is nothing', () => {
        expect(listLines([])).toEqual([
            'No Bedrock packs are listed. Put .mcpack or .mcaddon files in the packs folder and run /baddon reload.'
        ]);
    });

    it('lists each pack with its flags and download url', () => {
        expect(
            listLines([entry(), entry({ fileName: 'b.mcpack', addonPack: true, hasScripts: true, rtxEnabled: true })])
        ).toEqual([
            'Bedrock packs (2), in the order they are listed:',
            '1. a.mcpack: 627409cd-5207-46f1-b1e8-0d4492616419 v1.0.1, 4.9 MiB',
            '   http://127.0.0.1:8123/packs/a.mcpack',
            '2. b.mcpack: 627409cd-5207-46f1-b1e8-0d4492616419 v1.0.1, 4.9 MiB, add-on pack, scripts, ray tracing',
            '   http://127.0.0.1:8123/packs/a.mcpack'
        ]);
    });
});

describe('reloadLines', () => {
    it('pluralizes', () => {
        expect(reloadLines(1)[0]).toContain('1 pack listed');
        expect(reloadLines(0)[0]).toContain('0 packs listed');
        expect(reloadLines(2)[0]).toContain('2 packs listed');
    });
});
