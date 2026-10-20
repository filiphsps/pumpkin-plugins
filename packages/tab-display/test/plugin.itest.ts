import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtPluginPath, type PumpkinInstance, startPumpkin } from '@pumpkin-plugins/test-harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { info } from '../src/info.ts';

describe(info.name, () => {
    let server: PumpkinInstance;

    beforeAll(async () => {
        server = await startPumpkin({ name: 'tab-display', plugins: [builtPluginPath(process.cwd())] });
    });
    afterAll(async () => {
        await server?.stop();
        if (server) expect(server.errors()).toEqual([]);
    });

    it('loads on a real server', async () => {
        await server.waitForLog(new RegExp(`Loaded ${info.name}`));
        expect(server.errors()).toEqual([]);
    });

    it('creates config and serves status without an optional PumpkinPIE provider', async () => {
        const configPath = join(server.pluginDataDir(info.name), 'config.toml');
        expect(readFileSync(configPath, 'utf8')).toContain('[general]');

        const from = server.lines.length;
        server.command('tabdisplay status');
        await server.waitForLog(/Placeholder provider: (unavailable|ready)/, 5000, from);
        expect(server.errors()).toEqual([]);
    });

    it('keeps an invalid config file untouched when reload is rejected', async () => {
        const configPath = join(server.pluginDataDir(info.name), 'config.toml');
        const original = readFileSync(configPath, 'utf8');
        const invalid = original.replace('color = "#FFFFFF"', 'color = "white"');
        expect(invalid).not.toBe(original);
        writeFileSync(configPath, invalid);

        const from = server.lines.length;
        server.command('tabdisplay reload');
        await server.waitForLog(/TabDisplay reload failed: .*entry\.color/, 5000, from);
        expect(readFileSync(configPath, 'utf8')).toBe(invalid);

        writeFileSync(configPath, original);
        expect(server.errors()).toEqual([]);
    });
});
