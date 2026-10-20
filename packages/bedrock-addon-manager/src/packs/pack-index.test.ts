import { defaultValues } from '@pumpkin-plugins/config';
import { MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it } from 'vitest';
import { makeMcpack, manifestJson } from '../../test/fixtures.ts';
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

    it('returns undefined instead of throwing when a listed pack vanished before it was opened', () => {
        const { files, settings, index } = setup();
        files.put('packs/a.mcpack', pack(1));
        index.refresh(settings);
        files.remove('packs/a.mcpack');
        expect(index.open('a.mcpack')).toBeUndefined();
    });
});
