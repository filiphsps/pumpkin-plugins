import { MemoryFiles } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it } from 'vitest';
import { loadPluginConfig } from './load.ts';

describe(loadPluginConfig.name, () => {
    it('writes its built-in item and entity sources into a fresh configuration file', () => {
        const files = new MemoryFiles();

        const config = loadPluginConfig(files, () => undefined);

        expect(config.sources['minecraft:lava_bucket']?.light_level).toBe(15);
        expect(config.entities.enabled).toBe(true);
        expect(config.entities.refresh_interval_ticks).toBe(10);
        expect(config.entity_sources.blaze?.light_level).toBe(15);
        expect(files.text('config.toml')).toContain('[sources."minecraft:lava_bucket"]');
        expect(files.text('config.toml')).toContain('[entity_sources."blaze"]');
    });

    it('keeps a removed default source removed', () => {
        const files = new MemoryFiles().put('config.toml', '# User deliberately removed all sources.\n');

        expect(loadPluginConfig(files, () => undefined).sources).toEqual({});
    });
});
