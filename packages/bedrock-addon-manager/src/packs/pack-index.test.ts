import { defaultValues } from '@pumpkin-plugins/config';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { makeMcpack, manifestJson, noise } from '../../test/fixtures.ts';
import { MemoryLogger } from '../../test/logger.ts';
import { MemoryFiles } from '../../test/memory-files.ts';
import { type Config, configSchema } from '../config/schema.ts';
import { PackIndex } from './pack-index.ts';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pack = (n: number, version = [1, 0, 0]) => makeMcpack(manifestJson({ uuid: uuid(n), version }));

function setup(config: Partial<Config> = {}) {
    const files = new MemoryFiles();
    files.createDirectory('packs');
    const log = new MemoryLogger();
    const settings: Config = { ...defaultValues(configSchema), ...config };
    return { files, log, settings, index: new PackIndex(files, log) };
}

describe('PackIndex', () => {
    it('lists the packs it finds and says what it found', () => {
        const { files, log, settings, index } = setup();
        files.put('packs/a.mcpack', pack(1));
        index.refresh(settings);

        expect(index.entries.map((e) => [e.fileName, e.uuid])).toEqual([['a.mcpack', uuid(1)]]);
        expect(log.of('info')).toEqual([`Found 1 Bedrock pack: a.mcpack (${uuid(1)} v1.0.0).`]);
    });

    it('says so when there are no packs', () => {
        const { log, settings, index } = setup();
        index.refresh(settings);
        expect(log.of('info')).toEqual([
            'No packs in packs/. Put .mcpack or .mcaddon files there and run /baddon reload.'
        ]);
    });

    it('notices added, updated and removed packs on the next refresh', () => {
        const { files, settings, index } = setup();
        index.refresh(settings);
        files.put('packs/a.mcpack', pack(1));
        index.refresh(settings);
        expect(index.entries.map((e) => e.version)).toEqual(['1.0.0']);
        files.put('packs/a.mcpack', pack(1, [1, 1, 0]));
        index.refresh(settings);
        expect(index.entries.map((e) => e.version)).toEqual(['1.1.0']);
        files.remove('packs/a.mcpack');
        index.refresh(settings);
        expect(index.entries).toHaveLength(0);
    });

    it('opens a pack taken from a .mcaddon by the name it is listed under', () => {
        const { files, settings, index } = setup();
        files.put(
            'packs/Cool.mcaddon',
            zipSync({
                'RP/manifest.json': strToU8(JSON.stringify(manifestJson({ uuid: uuid(1) }))),
                'RP/a.png': noise(100)
            })
        );
        index.refresh(settings);
        expect(index.entries.map((e) => e.fileName)).toEqual(['Cool.mcpack']);
        expect(index.open('Cool.mcpack')?.size).toBeGreaterThan(100);
    });

    it('warns about a problem once, not on every scan, and again if it returns', () => {
        const { files, log, settings, index } = setup();
        files.put('packs/bad.mcpack', 'not a zip');
        index.refresh(settings);
        index.refresh(settings);
        expect(log.of('warn')).toEqual(['bad.mcpack: not a valid zip archive']);

        files.remove('packs/bad.mcpack');
        index.refresh(settings);
        files.put('packs/bad.mcpack', 'not a zip either');
        index.refresh(settings);
        expect(log.of('warn')).toHaveLength(2);
    });

    it('opens only packs that are in the list', () => {
        const { files, settings, index } = setup({
            overrides: { 'hidden.mcpack': { enabled: false } }
        });
        files.put('packs/a.mcpack', pack(1)).put('packs/hidden.mcpack', pack(2)).put('packs/secret.txt', 'x');
        index.refresh(settings);
        expect(index.open('a.mcpack')?.size).toBeGreaterThan(0);
        expect(index.open('hidden.mcpack')).toBeUndefined();
        expect(index.open('secret.txt')).toBeUndefined();
        expect(index.open('missing.mcpack')).toBeUndefined();
    });

    it('returns undefined instead of throwing when a listed pack vanished before it was opened', () => {
        const { files, settings, index } = setup();
        files.put('packs/a.mcpack', pack(1));
        index.refresh(settings);
        files.remove('packs/a.mcpack');
        expect(index.open('a.mcpack')).toBeUndefined();
    });
});
