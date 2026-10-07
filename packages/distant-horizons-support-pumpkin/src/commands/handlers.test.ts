import type { CommandSender } from 'pumpkin:plugin/command@0.1.0';
import { commandInfos } from '@pumpkin-plugins/docs';
import type { CommandHost } from '@pumpkin-plugins/plugin-kit/commands';
import { buildCommands } from '@pumpkin-plugins/plugin-kit/commands';
import { FakeCommandHost, type FakeNode, MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { unavailableChunkLoader, unavailableTerrainGenerator } from '@pumpkin-plugins/terrain';
import { describe, expect, it, vi } from 'vitest';
import { readSettings } from '../config/load.ts';
import { info } from '../info.ts';
import { LodCache } from '../lod/cache.ts';
import { type Peer, Sessions, sectionKey } from '../session.ts';
import { commandHandlers } from './handlers.ts';
import { commands } from './spec.ts';

const platform = vi.hoisted(() => ({ withPlayer: vi.fn() }));
vi.mock('../platform/peers.ts', () => ({ withPlayer: platform.withPlayer }));

let activePeer: Peer | undefined;

function setup() {
    const files = new MemoryFiles();
    const logger = new MemoryLogger();
    const settings = readSettings(files, logger);
    const cache = new LodCache(files, settings.memory_cache_entries, settings.disk_cache_entries);
    cache.put('first', { updated: 1, data: new Uint8Array(100) });
    const sessions = new Sessions(settings, cache, logger);
    activePeer = {
        name: 'Alice',
        level: 'world',
        dimension: 'minecraft:overworld',
        x: 70,
        z: 3,
        terrain: {
            minY: 0,
            height: 1,
            chunkLoader: unavailableChunkLoader,
            terrainGenerator: unavailableTerrainGenerator,
            sample: () => ({ material: 'minecraft:stone', skyLight: 15, blockLight: 0 })
        },
        insideBorder: () => true,
        report: () => undefined,
        send: () => undefined
    };
    platform.withPlayer.mockImplementation((_player: unknown, _settings: unknown, use: (peer: Peer) => void) => {
        if (!activePeer) return false;
        use(activePeer);
        return true;
    });
    const host = new FakeCommandHost();
    const [root] = buildCommands<CommandSender, typeof commands>(
        host as unknown as CommandHost<CommandSender>,
        commands,
        commandHandlers(sessions, cache, settings)
    );
    return { cache, host, root: root?.node as FakeNode, sessions };
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
            'DistantHorizonsSupportPumpkin:command.dhs.map.at-radius',
            'DistantHorizonsSupportPumpkin:command.dhs.generate.here',
            'DistantHorizonsSupportPumpkin:command.dhs.generate.here-radius',
            'DistantHorizonsSupportPumpkin:command.dhs.generate.at',
            'DistantHorizonsSupportPumpkin:command.dhs.generate.at-radius'
        ]);
        expect(info.commands.map(({ usage }) => usage)).toContain('/dhs map at-radius <x> <z> <radius>');
        expect(info.commands.map(({ usage }) => usage)).toEqual(
            expect.arrayContaining([
                '/dhs generate here',
                '/dhs generate here-radius <radius>',
                '/dhs generate at <x> <z>',
                '/dhs generate at-radius <x> <z> <radius>'
            ])
        );
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

    it('starts forced captures at the player or block coordinates with the selected radius', () => {
        const here = setup();
        const player = {
            getPosition: () => [70, 64, 3],
            getWorld: () => ({ getName: () => 'world', [Symbol.dispose]: () => undefined }),
            [Symbol.dispose]: () => undefined
        };
        const sender = { lines: [], errors: [], asPlayer: () => player };

        here.host.runAs(here.root, ['dhs', 'generate', 'here'], {}, sender as never);
        expect(sender.lines[0]).toContain('section 1, 0 (radius 0');
        expect(here.sessions.status()).toContain('Forced LOD capture for Alice');

        const hereRadius = setup();
        hereRadius.host.runAs(
            hereRadius.root,
            ['dhs', 'generate', 'here-radius', '<radius>'],
            { radius: 1 },
            sender as never
        );
        expect(sender.lines.at(-2)).toContain('section 1, 0 (radius 1');

        const at = setup();
        at.host.runAs(at.root, ['dhs', 'generate', 'at', '<x>', '<z>'], { x: -64, z: 128 }, sender as never);
        expect(sender.lines.at(-2)).toContain('section -1, 2 (radius 0');

        const atRadius = setup();
        atRadius.host.runAs(
            atRadius.root,
            ['dhs', 'generate', 'at-radius', '<x>', '<z>', '<radius>'],
            { x: 64, z: -64, radius: 2 },
            sender as never
        );
        expect(sender.lines.at(-2)).toContain('section 1, -1 (radius 2');
    });

    it('requires a Java player and rejects a second active forced capture', () => {
        const f = setup();
        const player = {
            getPosition: () => [0, 64, 0],
            getWorld: () => ({ getName: () => 'world', [Symbol.dispose]: () => undefined }),
            [Symbol.dispose]: () => undefined
        };
        const sender = { lines: [], errors: [], asPlayer: () => player };
        f.host.runAs(f.root, ['dhs', 'generate', 'here'], {}, sender as never);
        expect(() => f.host.runAs(f.root, ['dhs', 'generate', 'here'], {}, sender as never)).toThrow('already running');
        expect(() => f.host.run(f.root, ['dhs', 'generate', 'here'])).toThrow('Run this command as a Java player');
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
