import { commandInfos } from '@pumpkin-plugins/docs';
import { buildCommands } from '@pumpkin-plugins/plugin-kit/commands';
import { FakeCommandHost, type FakeNode, MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it } from 'vitest';
import { readSettings } from '../config/load.ts';
import { info } from '../info.ts';
import { LodCache } from '../lod/cache.ts';
import { Sessions } from '../session.ts';
import { commandHandlers } from './handlers.ts';
import { commands } from './spec.ts';

function setup() {
    const files = new MemoryFiles();
    const logger = new MemoryLogger();
    const settings = readSettings(files, logger);
    const cache = new LodCache(files, settings.memory_cache_entries, settings.disk_cache_entries);
    cache.put('first', { updated: 1, data: new Uint8Array(100) });
    const sessions = new Sessions(settings, cache, logger);
    const host = new FakeCommandHost();
    const [root] = buildCommands(host, commands, commandHandlers(sessions, cache));
    return { cache, host, root: root?.node as FakeNode };
}

describe('the /dhs commands', () => {
    it('registers every command listed in the README', () => {
        const { host, root } = setup();
        expect(host.usages(root).sort()).toEqual((info.commands ?? []).map((command) => command.usage).sort());
        expect(info.commands).toEqual(commandInfos(commands));
        expect(info.commands.map((command) => command.permission)).toEqual([
            'DistantHorizonsSupportPumpkin:command.dhs.status',
            'DistantHorizonsSupportPumpkin:command.dhs.cache.status',
            'DistantHorizonsSupportPumpkin:command.dhs.cache.clear',
            'DistantHorizonsSupportPumpkin:command.dhs.cache.memory.clear',
            'DistantHorizonsSupportPumpkin:command.dhs.cache.disk.clear'
        ]);
    });

    it('reports both cache tiers and their configured limits', () => {
        const { host, root } = setup();
        expect(host.run(root, ['dhs', 'cache', 'status'])).toEqual([
            'Memory cache: 1/128 entries, 100 bytes.',
            'Disk cache: 1/4096 entries, 127 bytes.'
        ]);
    });

    it('clears both tiers or either tier independently', () => {
        const all = setup();
        expect(all.host.run(all.root, ['dhs', 'cache', 'clear'])).toEqual([
            'Cleared 1 in-memory and 1 disk cache entries.'
        ]);
        expect(all.cache.stats()).toMatchObject({ memoryEntries: 0, diskEntries: 0 });

        const memory = setup();
        expect(memory.host.run(memory.root, ['dhs', 'cache', 'memory', 'clear'])).toEqual([
            'Cleared 1 in-memory cache entries.'
        ]);
        expect(memory.cache.stats()).toMatchObject({ memoryEntries: 0, diskEntries: 1 });

        const disk = setup();
        expect(disk.host.run(disk.root, ['dhs', 'cache', 'disk', 'clear'])).toEqual(['Cleared 1 disk cache entries.']);
        expect(disk.cache.stats()).toMatchObject({ memoryEntries: 1, diskEntries: 0 });
    });
});
