import { defaultValues } from '@pumpkin-plugins/config';
import { ansi } from '@pumpkin-plugins/minecraft-colors';
import { MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it } from 'vitest';
import { loadPluginConfig } from './load.ts';
import { CONFIG_FILE, configSchema } from './schema.ts';

describe('loadPluginConfig', () => {
    it('is silent when the file is already current', () => {
        const files = new MemoryFiles();
        loadPluginConfig(files, new MemoryLogger());
        const log = new MemoryLogger();
        loadPluginConfig(files, log);
        expect(log.lines).toEqual([]);
    });

    it('falls back to the defaults without touching a file that is not valid TOML', () => {
        const text = '[web\nport = 1';
        const files = new MemoryFiles().put(CONFIG_FILE, text);
        const log = new MemoryLogger();
        expect(loadPluginConfig(files, log)).toEqual(defaultValues(configSchema));
        expect(files.text(CONFIG_FILE)).toBe(text);
        expect(log.of('error')[0]).toContain(`${ansi.named.name('config.toml')} is not valid TOML (`);
        expect(log.of('error')[0]).toContain('Using the default settings until it is fixed; the file was not changed.');
    });
});
