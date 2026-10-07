import type { CommandSender } from 'pumpkin:plugin/command@0.1.0';
import { commandInfos } from '@pumpkin-plugins/docs';
import type { CommandHost } from '@pumpkin-plugins/plugin-kit/commands';
import { buildCommands } from '@pumpkin-plugins/plugin-kit/commands';
import { FakeCommandHost, type FakeNode, MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it } from 'vitest';
import { readSettings } from '../config/load.ts';
import { info } from '../info.ts';
import { LodCache } from '../lod/cache.ts';
import { Sessions, sectionKey } from '../session.ts';
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
    const [root] = buildCommands<CommandSender, typeof commands>(
        host as unknown as CommandHost<CommandSender>,
        commands,
        commandHandlers(sessions, cache)
    );
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
            'DistantHorizonsSupportPumpkin:command.dhs.cache.disk.clear',
            'DistantHorizonsSupportPumpkin:command.dhs.map.here',
            'DistantHorizonsSupportPumpkin:command.dhs.map.here-radius',
            'DistantHorizonsSupportPumpkin:command.dhs.map.at',
            'DistantHorizonsSupportPumpkin:command.dhs.map.at-radius'
        ]);
        expect(info.commands.map(({ usage }) => usage)).toContain('/dhs map at-radius <x> <z> <radius>');
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

    it('shows cached LOD sections around the player and at block coordinates with a chosen radius', () => {
        const { cache, host, root } = setup();
        cache.put(sectionKey('overworld', 1, 0), { updated: 1, data: new Uint8Array(64) });
        const player = {
            getPosition: () => [70, 64, 3],
            getWorld: () => ({ getName: () => 'overworld', [Symbol.dispose]: () => undefined }),
            [Symbol.dispose]: () => undefined
        };
        const sender = {
            lines: [],
            errors: [],
            asPlayer: () => player
        };

        host.runAs(root, ['dhs', 'map', 'here'], {}, sender as never);
        expect(sender.lines[0]).toContain('center section 1, 0');
        expect(sender.lines.at(-1)).toContain('built');
        expect(sender.lines.join('\n')).toContain('§e◆');

        sender.lines.length = 0;
        host.runAs(root, ['dhs', 'map', 'here-radius', '<radius>'], { radius: 0 }, sender as never);
        expect(sender.lines).toHaveLength(3);
        expect(sender.lines[0]).toContain('center section 1, 0');

        sender.lines.length = 0;
        host.runAs(
            root,
            ['dhs', 'map', 'at-radius', '<x>', '<z>', '<radius>'],
            { x: 64, z: 0, radius: 0 },
            sender as never
        );
        expect(sender.lines).toHaveLength(3);
        expect(sender.lines[0]).toContain('center section 1, 0');
        expect(sender.lines[1]).toContain('§e◆');
    });

    it('requires player context for map commands', () => {
        const { host, root } = setup();
        expect(() => host.run(root, ['dhs', 'map', 'here'])).toThrow('Run this command as a player');
    });

    it('rejects radii larger than the bounded map size', () => {
        const { host, root } = setup();
        const player = {
            getPosition: () => [0, 64, 0],
            getWorld: () => ({ getName: () => 'overworld', [Symbol.dispose]: () => undefined }),
            [Symbol.dispose]: () => undefined
        };
        const sender = { lines: [], errors: [], asPlayer: () => player };

        expect(() =>
            host.run(root, ['dhs', 'map', 'here-radius', '<radius>'], { radius: 17 }, sender as never)
        ).toThrow('Radius must be between 0 and 16 LOD sections.');
    });
});
