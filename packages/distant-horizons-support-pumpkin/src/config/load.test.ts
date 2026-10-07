import { MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it } from 'vitest';
import { readSettings } from './load.ts';

describe('DH settings', () => {
    it('creates documented defaults and keeps customized values during upgrades', () => {
        const files = new MemoryFiles(),
            log = new MemoryLogger();
        const initial = readSettings(files, log);
        expect(initial.render_distance).toBe(128);
        expect(initial.generation_requests_per_second).toBe(20);
        expect(initial.sync_requests_per_second).toBe(50);
        expect(initial.blocks_per_tick).toBe(8192);
        expect(initial.cached_requests_per_tick).toBe(8);
        expect(initial.cached_packets_per_tick).toBe(64);
        expect(initial.memory_cache_entries).toBe(512);
        expect(initial.disk_cache_entries).toBe(4096);
        expect(files.text('config.toml')).toContain('cached_requests_per_tick = 8');
        expect(files.text('config.toml')).toContain('cached_packets_per_tick = 64');
        files.put(
            'config.toml',
            '[support]\nrender_distance = 256\nserver_key = "my-server"\n[worlds.custom]\nheight = 512\n'
        );
        const settings = readSettings(files, log);
        expect(settings.render_distance).toBe(256);
        expect(settings.server_key).toBe('my-server');
        expect(settings.worlds.custom?.height).toBe(512);
        expect(files.text('config.toml')).toContain('blocks_per_tick = 8192');
        expect(files.text('config.toml')).toContain('cached_requests_per_tick = 8');
        expect(files.text('config.toml')).toContain('cached_packets_per_tick = 64');
    });
    it('copies a legacy cache limit into both new limits and uses each default when it is absent', () => {
        const files = new MemoryFiles(),
            log = new MemoryLogger();
        files.put('config.toml', '[support]\ncache_entries = 512\n');

        const settings = readSettings(files, log);
        const config = files.text('config.toml') ?? '';

        expect(settings.memory_cache_entries).toBe(512);
        expect(settings.disk_cache_entries).toBe(512);
        expect(config).toContain('memory_cache_entries = 512');
        expect(config).toContain('disk_cache_entries = 512');
        expect(config).not.toMatch(/^cache_entries =/m);
    });
    it('accepts any negative cache limit as unlimited', () => {
        const files = new MemoryFiles(),
            log = new MemoryLogger();
        files.put('config.toml', '[support]\nmemory_cache_entries = -42\ndisk_cache_entries = -99\n');

        const settings = readSettings(files, log);

        expect(settings.memory_cache_entries).toBe(-42);
        expect(settings.disk_cache_entries).toBe(-99);
    });
    it('accepts the development server sample cap without falling back to the default', () => {
        const files = new MemoryFiles(),
            log = new MemoryLogger();
        files.put('config.toml', '[support]\nblocks_per_tick = 32768\n');

        const settings = readSettings(files, log);

        expect(settings.blocks_per_tick).toBe(32768);
        expect(log.of('warn')).toHaveLength(0);
    });
    it('accepts separate DH request rates', () => {
        const files = new MemoryFiles(),
            log = new MemoryLogger();
        files.put('config.toml', '[support]\ngeneration_requests_per_second = 100\nsync_requests_per_second = 100\n');

        const settings = readSettings(files, log);

        expect(settings.generation_requests_per_second).toBe(100);
        expect(settings.sync_requests_per_second).toBe(100);
        expect(log.of('warn')).toHaveLength(0);
    });
    it('loads per-world 3D biome sampling when explicitly enabled', () => {
        const files = new MemoryFiles(),
            log = new MemoryLogger();
        files.put('config.toml', '[worlds."world"]\nsample_biomes_3d = true\n');

        const settings = readSettings(files, log);

        expect(settings.worlds.world).toMatchObject({ sample_biomes_3d: true });
        expect(log.of('warn')).toHaveLength(0);
    });
    it('treats arbitrarily large negative TOML integers as unlimited', () => {
        const files = new MemoryFiles(),
            log = new MemoryLogger();
        files.put(
            'config.toml',
            '[support]\nmemory_cache_entries = -9223372036854775808\ndisk_cache_entries = -9223372036854775808\n'
        );

        const settings = readSettings(files, log);

        expect(settings.memory_cache_entries).toBe(-1);
        expect(settings.disk_cache_entries).toBe(-1);
        expect(files.text('config.toml')).toContain('memory_cache_entries = -1');
        expect(files.text('config.toml')).toContain('disk_cache_entries = -1');
    });
    it('preserves invalid values and malformed TOML without overwriting user files', () => {
        const files = new MemoryFiles(),
            log = new MemoryLogger(),
            bad = '[support]\nrender_distance = -5\n';
        files.put('config.toml', bad);
        expect(readSettings(files, log).render_distance).toBe(128);
        expect(files.text('config.toml')).toBe(bad);
        expect(log.of('warn')).not.toHaveLength(0);
        files.put('config.toml', '[support');
        expect(() => readSettings(files, log)).toThrow();
        expect(files.text('config.toml')).toBe('[support');
    });
    it('preserves an invalid DH server identity without rewriting the config', () => {
        const files = new MemoryFiles(),
            log = new MemoryLogger(),
            original = '[support]\nserver_key = "lod.example"\n';
        files.put('config.toml', original);

        const settings = readSettings(files, log);

        expect(settings.server_key).toBe('');
        expect(files.text('config.toml')).toBe(original);
        expect(log.of('warn').join('\n')).toContain('Use at most 128 letters, digits, underscores or hyphens.');
    });
});
