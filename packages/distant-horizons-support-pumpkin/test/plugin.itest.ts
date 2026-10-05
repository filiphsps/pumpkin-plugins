import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { builtPluginPath, type PumpkinInstance, startPumpkin } from '@pumpkin-plugins/test-harness';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { info } from '../src/info.ts';

describe(info.name, () => {
    let server: PumpkinInstance;
    beforeAll(async () => {
        server = await startPumpkin({
            name: 'distant-horizons-support-pumpkin',
            plugins: [builtPluginPath(process.cwd())]
        });
    });
    afterAll(async () => {
        await server?.stop();
    });
    it('loads, installs settings, and reports supported capabilities through its command', async () => {
        await server.waitForLog(new RegExp(`Loaded ${info.name}`));
        await server.waitForLog(/serving DH protocol 16 from loaded chunks and cached terrain/);
        const config = await readFile(path.join(server.pluginDataDir(info.name), 'config.toml'), 'utf8');
        expect(config).toContain('render_distance = 128');
        expect(config).toContain('blocks_per_tick = 2048');
        expect(config).toContain('memory_cache_entries = 128');
        expect(config).toContain('disk_cache_entries = 4096');
        server.command('dhs status');
        await server.waitForLog(/0 DH client\(s\), 0 pending LOD request\(s\)/);
        const cacheStatusFrom = server.lines.length;
        server.command('dhs cache status');
        await server.waitForLog(/Memory cache: 0\/128 entries/, 5000, cacheStatusFrom);
        await server.waitForLog(/Disk cache: 0\/4096 entries/, 5000, cacheStatusFrom);
        const cacheClearFrom = server.lines.length;
        server.command('dhs cache clear');
        await server.waitForLog(/Cleared 0 in-memory and 0 disk cache entries/, 5000, cacheClearFrom);
        // A successful load alone does not prove that the worker's event is being dispatched.
        await vi.waitFor(
            async () => {
                const from = server.lines.length;
                server.command('dhs status');
                const line = await server.waitForLog(/worker tick\(s\)/, 1000, from);
                expect(line).toMatch(/[1-9][0-9]* worker tick\(s\)/);
            },
            { timeout: 5000, interval: 100 }
        );
        expect(server.errors()).toEqual([]);
    });
    it('keeps an existing configuration value on a real server restart', async () => {
        const custom = await startPumpkin({
            name: 'distant-horizons-custom-config',
            plugins: [builtPluginPath(process.cwd())],
            files: {
                [`plugins/data/${info.name}/config.toml`]:
                    '[support]\nrender_distance = 256\nserver_key = "integration-test"\ncache_entries = 512\n'
            }
        });
        try {
            await custom.waitForLog(new RegExp(`Loaded ${info.name}`));
            const config = await readFile(path.join(custom.pluginDataDir(info.name), 'config.toml'), 'utf8');
            expect(config).toContain('render_distance = 256');
            expect(config).toContain('server_key = "integration-test"');
            expect(config).toContain('blocks_per_tick = 2048');
            expect(config).toContain('memory_cache_entries = 512');
            expect(config).toContain('disk_cache_entries = 512');
            expect(config).not.toMatch(/^cache_entries =/m);
            expect(custom.errors()).toEqual([]);
        } finally {
            await custom.stop();
        }
    });
    it('treats full-range negative cache limits as unlimited on the real server', async () => {
        const custom = await startPumpkin({
            name: 'distant-horizons-unlimited-cache-config',
            plugins: [builtPluginPath(process.cwd())],
            files: {
                [`plugins/data/${info.name}/config.toml`]:
                    '[support]\nmemory_cache_entries = -9223372036854775808\ndisk_cache_entries = -9223372036854775808\n'
            }
        });
        try {
            await custom.waitForLog(new RegExp(`Loaded ${info.name}`));
            const config = await readFile(path.join(custom.pluginDataDir(info.name), 'config.toml'), 'utf8');
            expect(config).toContain('memory_cache_entries = -1');
            expect(config).toContain('disk_cache_entries = -1');
            const from = custom.lines.length;
            custom.command('dhs cache status');
            await custom.waitForLog(/Memory cache: 0\/unlimited entries/, 5000, from);
            await custom.waitForLog(/Disk cache: 0\/unlimited entries/, 5000, from);
            expect(custom.errors()).toEqual([]);
        } finally {
            await custom.stop();
        }
    });
});
