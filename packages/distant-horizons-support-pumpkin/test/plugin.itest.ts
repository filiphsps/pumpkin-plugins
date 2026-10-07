import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { MemoryFiles } from '@pumpkin-plugins/plugin-kit/testing';
import { builtPluginPath, type PumpkinInstance, startPumpkin } from '@pumpkin-plugins/test-harness';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { info } from '../src/info.ts';
import { LodCache } from '../src/lod/cache.ts';
import { PROTOCOL } from '../src/protocol/messages.ts';

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
        await server.waitForLog(new RegExp(`serving DH protocol ${PROTOCOL} from loaded chunks and cached terrain`));
        const config = await readFile(path.join(server.pluginDataDir(info.name), 'config.toml'), 'utf8');
        expect(config).toContain('render_distance = 128');
        expect(config).toContain('generation_requests_per_second = 20');
        expect(config).toContain('sync_requests_per_second = 50');
        expect(config).toContain('blocks_per_tick = 8192');
        expect(config).toContain('cached_requests_per_tick = 8');
        expect(config).toContain('cached_packets_per_tick = 64');
        expect(config).toContain('memory_cache_entries = 512');
        expect(config).toContain('disk_cache_entries = 4096');
        const statusFrom = server.lines.length;
        server.command('dhs status');
        const status = await server.waitForLog(
            /0 Distant Horizons client\(s\), 0 pending LOD request\(s\)/,
            5000,
            statusFrom
        );
        expect(status).toContain('pending LOD request(s)');
        const budget = await server.waitForLog(
            /Capture budget \d+\/8192 block samples\/tick at \d+(?:\.\d+)? MSPT/,
            5000,
            statusFrom
        );
        expect(budget).toMatch(/Capture budget \d+\/8192 block samples\/tick at \d+(?:\.\d+)? MSPT/);
        const cacheStatusFrom = server.lines.length;
        server.command('dhs cache status');
        await server.waitForLog(/Memory cache: 0\/512 entries/, 5000, cacheStatusFrom);
        await server.waitForLog(/Disk cache: 0\/4096 entries/, 5000, cacheStatusFrom);
        const cacheClearFrom = server.lines.length;
        server.command('dhs cache clear');
        await server.waitForLog(/Cleared 0 in-memory and 0 disk cache entries/, 5000, cacheClearFrom);
        const mapFrom = server.lines.length;
        server.command('dhs map 0 0 0');
        await server.waitForLog(/Run this command as a player so the current world is known/, 5000, mapFrom);
        const generateFrom = server.lines.length;
        server.command('dhs generate 0 0');
        await server.waitForLog(/Run this command as a Java player so the current world is known/, 5000, generateFrom);
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
                    '[support]\nrender_distance = 256\nserver_key = "integration-test"\nblocks_per_tick = 32768\ncache_entries = 512\n'
            }
        });
        try {
            await custom.waitForLog(new RegExp(`Loaded ${info.name}`));
            const config = await readFile(path.join(custom.pluginDataDir(info.name), 'config.toml'), 'utf8');
            expect(config).toContain('render_distance = 256');
            expect(config).toContain('server_key = "integration-test"');
            expect(config).toContain('blocks_per_tick = 32768');
            expect(config).toContain('memory_cache_entries = 512');
            expect(config).toContain('disk_cache_entries = 512');
            expect(config).not.toMatch(/^cache_entries =/m);
            expect(custom.errors()).toEqual([]);
        } finally {
            await custom.stop();
        }
    });
    it('finds and clears persisted LOD entries through Pumpkin’s data folder', async () => {
        const files = new MemoryFiles();
        const cache = new LodCache(files, 0, 4096);
        const key = 'integration-world:0:0';
        cache.put(key, { updated: 1234, data: new Uint8Array(64).fill(7) });
        const fileName = files.list('cache')[0];
        if (!fileName) throw new Error('Cache fixture was not persisted');
        const content = files.readFile(`cache/${fileName}`);
        const custom = await startPumpkin({
            name: 'distant-horizons-disk-cache',
            plugins: [builtPluginPath(process.cwd())],
            files: {
                [`plugins/data/${info.name}/config.toml`]: '[support]\nmemory_cache_entries = 0\n',
                [`plugins/data/${info.name}/cache/${fileName}`]: content
            }
        });
        try {
            await custom.waitForLog(new RegExp(`Loaded ${info.name}`));
            const cachePath = path.join(custom.pluginDataDir(info.name), 'cache', fileName);
            expect(new Uint8Array(await readFile(cachePath))).toEqual(content);

            const statusFrom = custom.lines.length;
            custom.command('dhs cache status');
            await custom.waitForLog(/Disk cache: 1\/4096 entries, \d+\s+B\./, 5000, statusFrom);

            const clearFrom = custom.lines.length;
            custom.command('dhs cache disk clear');
            await custom.waitForLog(/Cleared 1 disk cache entries\./, 5000, clearFrom);
            await expect(readFile(cachePath)).rejects.toMatchObject({ code: 'ENOENT' });
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
