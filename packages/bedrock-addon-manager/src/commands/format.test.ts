import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import type { PackEntry } from '../packs/entries.ts';
import { exportLines, formatSize, listLines } from './format.ts';

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
    ...over,
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
    it('says when there is nothing, and how to add packs', () => {
        expect(listLines([]).join('\n')).toContain('/baddon reload');
    });

    it('lists each pack in order with its name, uuid, version, size, flags and download url', () => {
        const text = listLines([
            entry(),
            entry({
                fileName: 'b.mcpack',
                uuid: '22222222-2222-4222-8222-222222222222',
                version: '3.1.4',
                downloadUrl: 'https://cdn.example.com/b.mcpack',
                addonPack: true,
                hasScripts: true,
                rtxEnabled: true,
            }),
        ]).join('\n');
        const a = text.indexOf('a.mcpack');
        const b = text.indexOf('b.mcpack');
        expect(a).toBeGreaterThanOrEqual(0);
        expect(b).toBeGreaterThan(a);
        for (const part of [
            '627409cd-5207-46f1-b1e8-0d4492616419',
            '1.0.1',
            '4.9 MiB',
            'http://127.0.0.1:8123/packs/a.mcpack',
        ]) {
            expect(text.slice(a, b)).toContain(part);
        }
        for (const part of [
            '22222222-2222-4222-8222-222222222222',
            '3.1.4',
            'https://cdn.example.com/b.mcpack',
            'add-on pack',
            'scripts',
            'ray tracing',
        ]) {
            expect(text.slice(b)).toContain(part);
        }
        expect(text.slice(a, b)).not.toContain('ray tracing');
    });
});

describe('exportLines', () => {
    it('prints a pumpkin.toml block with every pack in list order, exact sizes and the overrides', () => {
        const toml = parse(
            exportLines(
                [
                    entry({ fileName: 'b.mcpack', uuid: '22222222-2222-4222-8222-222222222222', size: 5184225 }),
                    entry({
                        subPackName: 'hd',
                        contentKey: 'key',
                        contentId: 'id-1',
                        addonPack: true,
                        rtxEnabled: true,
                    }),
                ],
                true,
            ).join('\n'),
        );
        expect(toml).toEqual({
            resource_pack: {
                bedrock: {
                    enabled: true,
                    force: true,
                    packs: [
                        {
                            uuid: '22222222-2222-4222-8222-222222222222',
                            version: '1.0.1',
                            size: 5184225,
                            download_url: 'http://127.0.0.1:8123/packs/a.mcpack',
                            has_scripts: false,
                            addon_pack: false,
                            rtx_enabled: false,
                        },
                        {
                            uuid: '627409cd-5207-46f1-b1e8-0d4492616419',
                            version: '1.0.1',
                            size: 5184225,
                            download_url: 'http://127.0.0.1:8123/packs/a.mcpack',
                            has_scripts: false,
                            addon_pack: true,
                            rtx_enabled: true,
                            sub_pack_name: 'hd',
                            content_key: 'key',
                            content_id: 'id-1',
                        },
                    ],
                },
            },
        });
    });

    it('escapes values so the block stays valid TOML', () => {
        const url = 'https://cdn.example.com/a "quoted" \\ pack.mcpack';
        const toml = parse(exportLines([entry({ downloadUrl: url })], false).join('\n')) as {
            resource_pack: { bedrock: { packs: { download_url: string }[] } };
        };
        expect(toml.resource_pack.bedrock.packs[0]?.download_url).toBe(url);
    });

    it('prints no block when there are no packs', () => {
        expect(exportLines([], false).join('\n')).not.toContain('[resource_pack');
    });
});
