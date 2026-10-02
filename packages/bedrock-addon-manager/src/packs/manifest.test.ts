import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { makeMcpack, manifestJson, noise, SAMPLE_UUID } from '../../test/fixtures.ts';
import { ManifestError, readManifest, stripJsonComments } from './manifest.ts';

describe('readManifest', () => {
    it('reads the uuid and version of a plain resource pack', () => {
        expect(readManifest(makeMcpack())).toEqual({
            uuid: SAMPLE_UUID,
            version: '1.0.1',
            name: 'Test Pack',
            moduleTypes: ['resources'],
            addonPack: false,
            hasScripts: false,
            rtxEnabled: false
        });
    });

    it('lowercases the uuid', () => {
        const pack = makeMcpack(manifestJson({ uuid: SAMPLE_UUID.toUpperCase() }));
        expect(readManifest(pack).uuid).toBe(SAMPLE_UUID);
    });

    it('finds the manifest inside a wrapping folder, preferring the shallowest', () => {
        const wrapped = makeMcpack(manifestJson({ version: [2, 3, 4] }), { folder: 'My Pack' });
        expect(readManifest(wrapped).version).toBe('2.3.4');

        const both = zipSync({
            'inner/deep/manifest.json': strToU8(JSON.stringify(manifestJson({ version: [9, 9, 9] }))),
            'inner/manifest.json': strToU8(JSON.stringify(manifestJson({ version: [1, 2, 3] })))
        });
        expect(readManifest(both).version).toBe('1.2.3');
    });

    it('accepts comments and a byte order mark', () => {
        const text = `\uFEFF// a pack
{ /* header */ "format_version": 2, "header": { "uuid": "${SAMPLE_UUID}", "version": [1, 0, 0], "name": "http://not-a-comment" }, "modules": [] }`;
        const manifest = readManifest(makeMcpack(text));
        expect(manifest.version).toBe('1.0.0');
        expect(manifest.name).toBe('http://not-a-comment');
    });

    it('accepts a semver string version', () => {
        expect(readManifest(makeMcpack(manifestJson({ version: '1.4.2-beta' }))).version).toBe('1.4.2');
    });

    it('derives the add-on and script flags from modules and dependencies', () => {
        const flags = (options: Parameters<typeof manifestJson>[0]) => {
            const m = readManifest(makeMcpack(manifestJson(options)));
            return [m.addonPack, m.hasScripts];
        };
        expect(flags({ modules: ['resources'] })).toEqual([false, false]);
        expect(flags({ modules: ['data'] })).toEqual([true, false]);
        expect(flags({ modules: ['script'] })).toEqual([true, true]);
        expect(flags({ modules: ['client_data'] })).toEqual([true, true]);
        expect(flags({ modules: ['resources'], dependencies: ['11111111-1111-4111-8111-111111111111'] })).toEqual([
            true,
            false
        ]);
    });

    it('detects the raytraced capability', () => {
        expect(readManifest(makeMcpack(manifestJson({ capabilities: ['raytraced'] }))).rtxEnabled).toBe(true);
        expect(readManifest(makeMcpack(manifestJson({ capabilities: ['pbr'] }))).rtxEnabled).toBe(false);
    });

    it('reads the manifest of a multi-megabyte archive', () => {
        const big = makeMcpack(manifestJson(), { files: { 'textures/big.png': noise(2 * 1024 * 1024) } });
        expect(big.length).toBeGreaterThan(2 * 1024 * 1024);
        expect(readManifest(big).uuid).toBe(SAMPLE_UUID);
    });

    it('explains what is wrong', () => {
        const error = (pack: Uint8Array) => {
            try {
                readManifest(pack);
            } catch (err) {
                expect(err).toBeInstanceOf(ManifestError);
                return (err as Error).message;
            }
            throw new Error('expected readManifest to throw');
        };
        expect(error(strToU8('definitely not a zip'))).toBe('not a valid zip archive');
        expect(error(zipSync({ 'readme.txt': strToU8('hi') }))).toBe('no manifest.json found');
        expect(error(makeMcpack('{ nope'))).toMatch(/not valid JSON/);
        expect(error(makeMcpack('{"modules": []}'))).toBe('manifest.json has no header');
        expect(error(makeMcpack(manifestJson({ uuid: 'not-a-uuid' })))).toBe('header.uuid is missing or not a UUID');
        expect(error(makeMcpack(manifestJson({ version: [1, 0] })))).toBe(
            'header.version must be [major, minor, patch]'
        );
    });
});

describe('stripJsonComments', () => {
    it('keeps strings that contain comment markers and escaped quotes', () => {
        const text = '{ "a": "x // y /* z */", "b": "q\\" // still a string" } // trailing';
        expect(JSON.parse(stripJsonComments(text))).toEqual({ a: 'x // y /* z */', b: 'q" // still a string' });
    });

    it('survives an unterminated block comment', () => {
        expect(stripJsonComments('{"a":1} /* never closed')).toBe('{"a":1} ');
    });
});
