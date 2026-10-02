import { defaultValues } from '@pumpkin-plugins/config';
import { describe, expect, it } from 'vitest';
import { makeMcpack, manifestJson } from '../../test/fixtures.ts';
import { type Config, configSchema } from '../config/schema.ts';
import { buildEntries, packUrl, publicBaseUrl, type ScannedPack } from './entries.ts';
import { readManifest } from './manifest.ts';

const DEFAULT: Config = defaultValues(configSchema);

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function scanned(fileName: string, n: number, extra: Parameters<typeof manifestJson>[0] = {}): ScannedPack {
    const manifest = readManifest(makeMcpack(manifestJson({ uuid: uuid(n), ...extra })));
    return { fileName, path: `packs/${fileName}`, size: 1000 + n, modified: 0, manifest };
}

const withOverrides = (overrides: Config['overrides'], web: Partial<Config['web']> = {}): Config => ({
    ...DEFAULT,
    web: { ...DEFAULT.web, ...web },
    overrides
});

describe('buildEntries', () => {
    it('takes uuid, version, size and url from the pack', () => {
        const { entries, warnings } = buildEntries([scanned('My Pack.mcpack', 1)], DEFAULT);
        expect(warnings).toEqual([]);
        expect(entries).toEqual([
            {
                fileName: 'My Pack.mcpack',
                path: 'packs/My Pack.mcpack',
                uuid: uuid(1),
                version: '1.0.1',
                size: 1001,
                downloadUrl: 'http://127.0.0.1:8123/packs/My%20Pack.mcpack',
                order: 0,
                addonPack: false,
                hasScripts: false,
                rtxEnabled: false,
                contentKey: undefined,
                subPackName: undefined,
                contentId: undefined
            }
        ]);
    });

    it('orders by order, then case-insensitively by file name', () => {
        const packs = [scanned('b.mcpack', 1), scanned('C.mcpack', 2), scanned('a.mcpack', 3), scanned('z.mcpack', 4)];
        const config = withOverrides({ 'z.mcpack': { order: -1 }, 'a.mcpack': { order: 5 } });
        expect(buildEntries(packs, config).entries.map((e) => e.fileName)).toEqual([
            'z.mcpack',
            'b.mcpack',
            'C.mcpack',
            'a.mcpack'
        ]);
    });

    it('uses public_url for downloads and lets an override replace the whole url', () => {
        const config = withOverrides(
            { 'b.mcpack': { download_url: 'https://cdn.example.com/b.mcpack' } },
            { public_url: 'https://packs.example.com' }
        );
        const entries = buildEntries([scanned('a.mcpack', 1), scanned('b.mcpack', 2)], config).entries;
        expect(entries.map((e) => e.downloadUrl)).toEqual([
            'https://packs.example.com/packs/a.mcpack',
            'https://cdn.example.com/b.mcpack'
        ]);
    });

    it('lets overrides win over the manifest', () => {
        const config = withOverrides({
            'a.mcpack': {
                addon_pack: true,
                has_scripts: true,
                rtx_enabled: true,
                content_key: 'key',
                sub_pack_name: 'hd',
                content_id: 'id'
            }
        });
        const [entry] = buildEntries([scanned('a.mcpack', 1)], config).entries;
        expect(entry).toMatchObject({
            addonPack: true,
            hasScripts: true,
            rtxEnabled: true,
            contentKey: 'key',
            subPackName: 'hd',
            contentId: 'id'
        });
    });

    it('lets an override turn a manifest-derived flag off', () => {
        const pack = scanned('a.mcpack', 1, { modules: ['script'] });
        const [entry] = buildEntries(
            [pack],
            withOverrides({ 'a.mcpack': { addon_pack: false, has_scripts: false } })
        ).entries;
        expect(entry).toMatchObject({ addonPack: false, hasScripts: false });
    });

    it('leaves out disabled packs', () => {
        const config = withOverrides({ 'a.mcpack': { enabled: false } });
        expect(
            buildEntries([scanned('a.mcpack', 1), scanned('b.mcpack', 2)], config).entries.map((e) => e.fileName)
        ).toEqual(['b.mcpack']);
    });

    it('skips the later pack when two share a uuid', () => {
        const { entries, warnings } = buildEntries([scanned('b.mcpack', 1), scanned('a.mcpack', 1)], DEFAULT);
        expect(entries.map((e) => e.fileName)).toEqual(['a.mcpack']);
        expect(warnings).toEqual(['b.mcpack has the same UUID as a.mcpack; skipping it']);
    });

    it('warns about overrides that match nothing', () => {
        const config = withOverrides({ 'gone.mcpack': { order: 1 } });
        expect(buildEntries([scanned('a.mcpack', 1)], config).warnings).toEqual([
            'overrides."gone.mcpack" matches no pack in the packs folder'
        ]);
    });
});

describe('urls', () => {
    it('falls back to loopback on the web port and says so', () => {
        expect(publicBaseUrl(withOverrides({}, { port: 9000 }))).toEqual({
            url: 'http://127.0.0.1:9000',
            isDefault: true
        });
        expect(publicBaseUrl(withOverrides({}, { public_url: 'https://x.test' }))).toEqual({
            url: 'https://x.test',
            isDefault: false
        });
    });

    it('percent-encodes file names', () => {
        expect(packUrl('http://h', 'A b&c/ü.mcpack')).toBe('http://h/packs/A%20b%26c%2F%C3%BC.mcpack');
    });
});
