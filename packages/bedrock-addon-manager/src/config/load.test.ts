import { defaultValues } from '@pumpkin-plugins/config';
import { describe, expect, it } from 'vitest';
import { MemoryLogger } from '../../test/logger.ts';
import { MemoryFiles } from '../../test/memory-files.ts';
import { loadPluginConfig } from './load.ts';
import { CONFIG_FILE, configSchema } from './schema.ts';

describe('loadPluginConfig', () => {
    it('creates the file on first start and says so', () => {
        const files = new MemoryFiles();
        const log = new MemoryLogger();
        expect(loadPluginConfig(files, log)).toEqual(defaultValues(configSchema));
        expect(files.text(CONFIG_FILE)).toContain('[web]');
        expect(log.lines).toEqual(['info: Created config.toml with the default settings.']);
    });

    it('is silent when the file is already current', () => {
        const files = new MemoryFiles();
        loadPluginConfig(files, new MemoryLogger());
        const log = new MemoryLogger();
        loadPluginConfig(files, log);
        expect(log.lines).toEqual([]);
    });

    it('reports what an upgrade added and removed', () => {
        const files = new MemoryFiles().put(CONFIG_FILE, '[web]\nport = 9000\nold = 1\n');
        const log = new MemoryLogger();
        const config = loadPluginConfig(files, log);
        expect(config.web.port).toBe(9000);
        expect(log.of('info')).toHaveLength(1);
        expect(log.of('info')[0]).toMatch(/^Updated config\.toml: added web\.enabled, .*; removed web\.old\.$/);
    });

    it('leaves a file with an invalid value alone and tells the admin how to proceed', () => {
        const text = '[web]\nport = "x"\n';
        const files = new MemoryFiles().put(CONFIG_FILE, text);
        const log = new MemoryLogger();
        expect(loadPluginConfig(files, log).web.port).toBe(8123);
        expect(files.text(CONFIG_FILE)).toBe(text);
        expect(log.of('warn')).toEqual([
            'config.toml: web.port must be a whole number from 1 to 65535; using 8123',
            'config.toml has invalid values, so it was left as it is. Fix them and run /baddon reload.'
        ]);
    });

    it('falls back to the defaults without touching a file that is not valid TOML', () => {
        const text = '[web\nport = 1';
        const files = new MemoryFiles().put(CONFIG_FILE, text);
        const log = new MemoryLogger();
        expect(loadPluginConfig(files, log)).toEqual(defaultValues(configSchema));
        expect(files.text(CONFIG_FILE)).toBe(text);
        expect(log.of('error')[0]).toMatch(
            /^config\.toml is not valid TOML \(.*\)\. Using the default settings until it is fixed; the file was not changed\.$/
        );
    });
});
