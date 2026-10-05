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

    it('keeps invalid values for the user to fix', () => {
        const original = '[entities]\nrefresh_interval_ticks = 0\n';
        const files = new MemoryFiles().put('config.toml', original);
        const reports: { level: string; message: string }[] = [];

        const config = loadPluginConfig(files, (level, message) => reports.push({ level, message }));

        expect(config.entities.refresh_interval_ticks).toBe(10);
        expect(files.text('config.toml')).toBe(original);
        expect(
            reports.some(({ level, message }) => level === 'warn' && message.includes('must be a whole number'))
        ).toBe(true);
    });

    it('uses defaults and preserves a file with invalid TOML', () => {
        const original = '[entities\nrefresh_interval_ticks = 10';
        const files = new MemoryFiles().put('config.toml', original);
        const reports: { level: string; message: string }[] = [];

        const config = loadPluginConfig(files, (level, message) => reports.push({ level, message }));

        expect(config.entities.enabled).toBe(true);
        expect(files.text('config.toml')).toBe(original);
        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatchObject({ level: 'error' });
        expect(reports[0]?.message).toContain('is not valid TOML');
    });
});
