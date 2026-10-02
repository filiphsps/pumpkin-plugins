import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { makeMcpack, manifestJson, noise } from '../../test/fixtures.ts';
import { readAddon } from './addon.ts';
import { readManifest } from './manifest.ts';

const RP = '627409cd-5207-46f1-b1e8-0d4492616419';
const BP = '33333333-3333-4333-8333-333333333333';

const manifest = (uuid: string, modules: string[]) => strToU8(JSON.stringify(manifestJson({ uuid, modules })));

describe('readAddon', () => {
    it('extracts the resource pack from a bundle of folders and skips the behavior pack', () => {
        const addon = zipSync({
            'Cool RP/manifest.json': manifest(RP, ['resources']),
            'Cool RP/textures/a.png': noise(500),
            'Cool BP/manifest.json': manifest(BP, ['data']),
            'Cool BP/entities/a.json': strToU8('{}')
        });
        const { packs, skipped } = readAddon(addon);

        expect(packs.map((p) => p.name)).toEqual(['Cool RP']);
        expect(packs[0].manifest.uuid).toBe(RP);
        expect(skipped).toEqual(['Cool BP (data, not a resource pack)']);
        // The repackaged pack is a valid .mcpack with its files at the root.
        expect(readManifest(packs[0].bytes).uuid).toBe(RP);
    });

    it('keeps the pack contents intact when repackaging', () => {
        const texture = noise(2000, 9);
        const { packs } = readAddon(
            zipSync({ 'RP/manifest.json': manifest(RP, ['resources']), 'RP/textures/a.png': texture })
        );
        const inner = readAddon(packs[0].bytes.length ? zipSync({ 'x.mcpack': packs[0].bytes }) : packs[0].bytes);
        expect(inner.packs).toHaveLength(1);
        expect(packs[0].bytes.length).toBeGreaterThan(texture.length);
    });

    it('extracts nested .mcpack archives as they are', () => {
        const rp = makeMcpack(manifestJson({ uuid: RP }));
        const bp = makeMcpack(manifestJson({ uuid: BP, modules: ['data'] }));
        const { packs, skipped } = readAddon(zipSync({ 'Addon RP.mcpack': rp, 'Addon BP.mcpack': bp }));
        expect(packs.map((p) => p.name)).toEqual(['Addon RP']);
        expect(packs[0].bytes).toEqual(rp);
        expect(skipped).toEqual(['Addon BP (data, not a resource pack)']);
    });

    it('handles a bundle that is a single pack at its root', () => {
        const { packs } = readAddon(zipSync({ 'manifest.json': manifest(RP, ['resources']) }));
        expect(packs.map((p) => p.name)).toEqual(['pack']);
    });

    it('returns every resource pack when there are several', () => {
        const { packs } = readAddon(
            zipSync({
                'Hi/manifest.json': manifest(RP, ['resources']),
                'Lo/manifest.json': manifest('44444444-4444-4444-8444-444444444444', ['resources'])
            })
        );
        expect(packs.map((p) => p.name).sort()).toEqual(['Hi', 'Lo']);
    });

    it('does not count a pack inside another pack as a second pack', () => {
        const { packs } = readAddon(
            zipSync({
                'Outer/manifest.json': manifest(RP, ['resources']),
                'Outer/sub/manifest.json': manifest(BP, ['resources'])
            })
        );
        expect(packs.map((p) => p.name)).toEqual(['Outer']);
    });

    it('explains packs whose manifest is unusable and carries on with the others', () => {
        const { packs, skipped } = readAddon(
            zipSync({
                'Good/manifest.json': manifest(RP, ['resources']),
                'Broken/manifest.json': strToU8('{ nope')
            })
        );
        expect(packs.map((p) => p.name)).toEqual(['Good']);
        expect(skipped).toHaveLength(1);
        expect(skipped[0]).toMatch(/^Broken: .*not valid JSON/);
    });

    it('rejects something that is not a zip', () => {
        expect(() => readAddon(strToU8('nope'))).toThrow('not a valid zip archive');
    });

    it('finds nothing in a bundle without packs', () => {
        expect(readAddon(zipSync({ 'readme.txt': strToU8('hi') }))).toEqual({ packs: [], skipped: [] });
    });
});
