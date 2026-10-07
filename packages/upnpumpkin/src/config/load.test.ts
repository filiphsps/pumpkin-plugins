import { ansi } from '@pumpkin-plugins/minecraft-colors';
import { MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it } from 'vitest';
import { loadPluginConfig } from './load.ts';

describe(loadPluginConfig.name, () => {
    it('creates the default config and reports its creation', () => {
        const files = new MemoryFiles();
        const log = new MemoryLogger();

        const config = loadPluginConfig(files, log);

        expect(config.java.port).toBe(25565);
        expect(config.bedrock.port).toBe(19132);
        expect(files.text('config.toml')).toContain('Changes apply after `/upnp reload`');
        expect(log.of('info')).toContain(`Created ${ansi.named.name('config.toml')} with the default settings.`);
    });

    it('keeps invalid values for the user to fix', () => {
        const original = '[java]\nport = 0\n';
        const files = new MemoryFiles().put('config.toml', original);
        const log = new MemoryLogger();

        const config = loadPluginConfig(files, log);

        expect(config.java.port).toBe(25565);
        expect(files.text('config.toml')).toBe(original);
        expect(log.of('warn').join('\n')).toMatch(/has invalid values, so it was left as it is/);
    });

    it('uses defaults and preserves a file with invalid TOML', () => {
        const original = '[java\nport = 1';
        const files = new MemoryFiles().put('config.toml', original);
        const log = new MemoryLogger();

        const config = loadPluginConfig(files, log);

        expect(config.java.port).toBe(25565);
        expect(files.text('config.toml')).toBe(original);
        expect(log.of('error')[0]).toContain('is not valid TOML');
        expect(log.of('error')[0]).toContain('file was not changed');
    });

    it('preserves configured values and reports added and removed settings on upgrade', () => {
        const files = new MemoryFiles().put('config.toml', '[router]\nupnp = false\nobsolete = true\n');
        const log = new MemoryLogger();

        const config = loadPluginConfig(files, log);

        expect(config.router.upnp).toBe(false);
        expect(files.text('config.toml')).not.toContain('obsolete');
        expect(log.of('info').join('\n')).toMatch(/Updated .*added .*router\.nat_pmp/);
        expect(log.of('info').join('\n')).toMatch(/removed .*router\.obsolete/);
    });
});
