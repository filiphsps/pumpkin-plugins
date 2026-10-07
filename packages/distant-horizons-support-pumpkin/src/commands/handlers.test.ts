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
        borderBounds: { minX: -1_000_000, maxX: 1_000_000, minZ: -1_000_000, maxZ: 1_000_000 },
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
            'DistantHorizonsSupportPumpkin:command.dhs.map',
            'DistantHorizonsSupportPumpkin:command.dhs.map',
            'DistantHorizonsSupportPumpkin:command.dhs.map',
            'DistantHorizonsSupportPumpkin:command.dhs.map',
            'DistantHorizonsSupportPumpkin:command.dhs.generate',
            'DistantHorizonsSupportPumpkin:command.dhs.generate',
            'DistantHorizonsSupportPumpkin:command.dhs.generate',
            'DistantHorizonsSupportPumpkin:command.dhs.generate'
        ]);
        expect(info.commands.map(({ usage }) => usage)).toEqual(
            expect.arrayContaining([
                '/dhs map',
                '/dhs map <radius>',
                '/dhs map <x> <z>',
                '/dhs map <x> <z> <radius>',
                '/dhs generate',
                '/dhs generate <radius>',
                '/dhs generate <x> <z>',
                '/dhs generate <x> <z> <radius>'
            ])
        );
    });

    it('reports both cache tiers and their configured limits', () => {
        const { host, root } = setup();
        expect(host.run(root, ['dhs', 'cache', 'status'])).toEqual([
            '§3Memory cache§r: §61§r/§6512§r entries, §6100\u00a0B§r',
            '§3Disk cache§r: §61§r/§64096§r entries, §6127\u00a0B§r.'
        ]);
    });

    it('colors the changing values in the status output', () => {
        const { host, root } = setup();

        const status = host.run(root, ['dhs', 'status']);

        expect(status.length).toBeGreaterThan(1);
        expect(status[0]).toContain('§60§r Distant Horizons client(s), §60§r pending LOD request(s)');
        expect(status.find((line) => line.includes('Capture budget'))).toContain(
            'Capture budget §60§r/§68192§r block samples/tick at §60.0§r MSPT'
        );
        expect(status.every((line) => line.length <= 120)).toBe(true);
    });

    it('clears both tiers or either tier independently', () => {
        const all = setup();
        expect(all.host.run(all.root, ['dhs', 'cache', 'clear'])).toEqual([
            'Cleared §61§r in-memory and §61§r disk cache entries.'
        ]);
        expect(all.cache.stats()).toMatchObject({ memoryEntries: 0, diskEntries: 0 });

        const memory = setup();
        expect(memory.host.run(memory.root, ['dhs', 'cache', 'memory', 'clear'])).toEqual([
            'Cleared §61§r in-memory cache entries.'
        ]);
        expect(memory.cache.stats()).toMatchObject({ memoryEntries: 0, diskEntries: 1 });

        const disk = setup();
        expect(disk.host.run(disk.root, ['dhs', 'cache', 'disk', 'clear'])).toEqual([
            'Cleared §61§r disk cache entries.'
        ]);
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

        host.runAs(root, ['dhs', 'map'], {}, sender as never);
        expect(sender.lines[0]).toContain('center section 1, 0');
        expect(sender.lines.at(-1)).toContain('built');
        expect(sender.lines.join('\n')).toContain('§e◆');

        sender.lines.length = 0;
        host.runAs(root, ['dhs', 'map', '<radius>'], { radius: 0 }, sender as never);
        expect(sender.lines).toHaveLength(3);
        expect(sender.lines[0]).toContain('center section 1, 0');

        sender.lines.length = 0;
        host.runAs(root, ['dhs', 'map', '<x>', '<z>', '<radius>'], { x: 64, z: 0, radius: 0 }, sender as never);
        expect(sender.lines).toHaveLength(3);
        expect(sender.lines[0]).toContain('center section 1, 0');
        expect(sender.lines[1]).toContain('§e◆');

        sender.lines.length = 0;
        host.runAs(root, ['dhs', 'map', '<x>', '<z>'], { x: 64, z: 0 }, sender as never);
        expect(sender.lines).toHaveLength(11);
        expect(sender.lines[0]).toContain('center section 1, 0');
    });

    it('requires player context for map commands', () => {
        const { host, root } = setup();
        expect(() => host.run(root, ['dhs', 'map'])).toThrow('Run this command as a player');
    });

    it('starts forced captures at the player or block coordinates with the selected radius', () => {
        const here = setup();
        const player = {
            getPosition: () => [70, 64, 3],
            getWorld: () => ({ getName: () => 'world', [Symbol.dispose]: () => undefined }),
            [Symbol.dispose]: () => undefined
        };
        const sender = { lines: [], errors: [], asPlayer: () => player };

        here.host.runAs(here.root, ['dhs', 'generate'], {}, sender as never);
        expect(sender.lines[0]).toContain('section §61§r, §60§r (radius §60§r');
        expect(here.sessions.status()).toContain('Forced LOD capture for Alice');

        const hereRadius = setup();
        hereRadius.host.runAs(hereRadius.root, ['dhs', 'generate', '<radius>'], { radius: 1 }, sender as never);
        expect(sender.lines.at(-3)).toContain('section §61§r, §60§r (radius §61§r');

        const at = setup();
        at.host.runAs(at.root, ['dhs', 'generate', '<x>', '<z>'], { x: -64, z: 128 }, sender as never);
        expect(sender.lines.at(-3)).toContain('section §6-1§r, §62§r (radius §60§r');

        const atRadius = setup();
        atRadius.host.runAs(
            atRadius.root,
            ['dhs', 'generate', '<x>', '<z>', '<radius>'],
            { x: 64, z: -64, radius: 2 },
            sender as never
        );
        expect(sender.lines.at(-3)).toContain('section §61§r, §6-1§r (radius §62§r');
    });

    it('requires a Java player and rejects a second active forced capture', () => {
        const f = setup();
        const player = {
            getPosition: () => [0, 64, 0],
            getWorld: () => ({ getName: () => 'world', [Symbol.dispose]: () => undefined }),
            [Symbol.dispose]: () => undefined
        };
        const sender = { lines: [], errors: [], asPlayer: () => player };
        f.host.runAs(f.root, ['dhs', 'generate'], {}, sender as never);
        expect(() => f.host.runAs(f.root, ['dhs', 'generate'], {}, sender as never)).toThrow('already running');
        expect(() => f.host.run(f.root, ['dhs', 'generate'])).toThrow('Run this command as a Java player');
    });

    it('rejects radii larger than either command limit', () => {
        const { host, root } = setup();
        const player = {
            getPosition: () => [0, 64, 0],
            getWorld: () => ({ getName: () => 'overworld', [Symbol.dispose]: () => undefined }),
            [Symbol.dispose]: () => undefined
        };
        const sender = { lines: [], errors: [], asPlayer: () => player };

        expect(() => host.run(root, ['dhs', 'map', '<radius>'], { radius: 16_385 }, sender as never)).toThrow(
            'Radius must be between 0 and 16384 LOD sections.'
        );
        expect(() => host.run(root, ['dhs', 'generate', '<radius>'], { radius: 16_385 })).toThrow(
            'Radius must be between 0 and 16384 LOD sections.'
        );
    });

    it('sends status details as separate chat-sized lines', () => {
        const { host, root } = setup();
        const status = host.run(root, ['dhs', 'status']).map((line) => line.replace(/§./g, ''));

        expect(status).toHaveLength(5);
        expect(status[0]).toContain('0 Distant Horizons client(s), 0 pending LOD request(s)');
        expect(status.some((line) => line.includes('Capture budget 8192/8192 block samples/tick at 0.0 MSPT'))).toBe(
            true
        );
        expect(status.every((line) => line.length <= 120)).toBe(true);
    });
});
