import type { CommandSender } from 'pumpkin:plugin/command@0.1.0';
import type { Player } from 'pumpkin:plugin/player@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it, vi } from 'vitest';
import { WaypointCatalog } from '../waypoints/catalog.ts';
import { WaypointStore } from '../waypoints/store.ts';
import {
    commandHandlers,
    onlinePlayerNameSuggestions,
    resetPropertySuggestions,
    waypointNameSuggestions,
} from './handlers.ts';
import { ADMIN_PERMISSION } from './spec.ts';

const playerId = '22222222-2222-4222-8222-222222222222';
const waypointId = '11111111-1111-4111-8111-111111111111';

function setup(isOperator = false, pendingItemIconInput?: string, isAdmin = isOperator) {
    const files = new MemoryFiles();
    const catalog = new WaypointCatalog(new WaypointStore(files, new MemoryLogger()));
    const world = { getName: () => 'world', getMinY: () => -64, [Symbol.dispose]: vi.fn() };
    const player = {
        getId: () => ({ high: 1n, low: 2n }),
        getName: () => 'Alex',
        getPosition: () => [12.375, 64.5, -8.25],
        getYaw: () => 135,
        getPitch: () => -12,
        getWorld: () => world,
        teleport: vi.fn(),
        hasPermission: vi.fn(() => true),
        [Symbol.dispose]: vi.fn(),
    } as unknown as Player;
    const getAllPlayers = vi.fn(() => [player]);
    const opManager = { isOp: vi.fn(() => isOperator), [Symbol.dispose]: vi.fn() };
    const server = {
        getOpManager: () => opManager,
        getWorldByName: vi.fn((name: string) => (name === 'world' ? world : undefined)),
        getAllPlayers,
        getPlayerByName: vi.fn(),
    } as unknown as Server;
    const sender = {
        asPlayer: () => player,
        isPlayer: () => true,
        isConsole: () => false,
        hasPermission: vi.fn((_server: Server, node: string) => node !== ADMIN_PERMISSION || isAdmin),
    } as unknown as CommandSender;
    const consoleSender = {
        asPlayer: () => undefined,
        isPlayer: () => false,
        isConsole: () => true,
        hasPermission: () => true,
    } as unknown as CommandSender;
    const runtime = {
        server,
        catalog,
        createWaypointId: () => waypointId,
        uuidToString: () => playerId,
        uuidFromString: (id: string) => (/^[0-9a-f-]{36}$/i.test(id) ? ({ high: 1n, low: 2n } as never) : undefined),
        consumePendingItemIconInput: () => pendingItemIconInput,
        validateItemIcon: () => true,
    };
    const handlers = commandHandlers(runtime);
    return {
        catalog,
        consoleSender,
        files,
        getAllPlayers,
        handlers,
        opManager,
        player,
        runtime,
        sender,
        server,
        world,
    };
}

describe('/wp handlers', () => {
    it('suggests only enabled waypoints accessible to the requesting player', () => {
        const { catalog, runtime, sender } = setup(false);
        catalog.create({
            id: waypointId,
            name: 'Market Place',
            dimension: 'world',
            position: { x: 0, y: 64, z: 0 },
            access: { mode: 'public', grants: [] },
        });
        catalog.create({
            id: '33333333-3333-4333-8333-333333333333',
            name: 'Meadow',
            dimension: 'world',
            position: { x: 0, y: 64, z: 0 },
            access: { mode: 'restricted', grants: [{ type: 'player', playerId }] },
        });
        catalog.create({
            id: '44444444-4444-4444-8444-444444444444',
            name: 'Mine',
            dimension: 'world',
            position: { x: 0, y: 64, z: 0 },
            access: {
                mode: 'restricted',
                grants: [{ type: 'player', playerId: '55555555-5555-4555-8555-555555555555' }],
            },
        });
        catalog.create({
            id: '66666666-6666-4666-8666-666666666666',
            name: 'Mountain',
            dimension: 'world',
            position: { x: 0, y: 64, z: 0 },
            enabled: false,
            access: { mode: 'public', grants: [] },
        });

        expect(
            waypointNameSuggestions(runtime)(sender, {
                input: '/wp tp m',
                cursor: 8,
                start: 7,
                remaining: 'm',
            }),
        ).toEqual(['"Market Place"', 'Meadow']);
        expect(
            waypointNameSuggestions(runtime)(sender, {
                input: '/wp reset color m',
                cursor: 17,
                start: 16,
                remaining: 'm',
            }),
        ).toEqual(['"Market Place"', 'Meadow']);
    });

    it('does not suggest existing names for a new waypoint', () => {
        const { catalog, runtime, sender } = setup(true);
        catalog.create({ id: waypointId, name: 'Market', dimension: 'world', position: { x: 0, y: 64, z: 0 } });

        expect(
            waypointNameSuggestions(runtime)(sender, { input: '/wp create M', cursor: 12, start: 11, remaining: 'M' }),
        ).toEqual([]);
    });

    it('suggests resettable properties and filters them by the typed prefix', () => {
        const { sender } = setup(true);

        expect(resetPropertySuggestions(sender, { input: '/wp reset ', cursor: 10, start: 10, remaining: '' })).toEqual(
            ['color', 'description', 'icon', 'label', 'visibility-range'],
        );
        expect(
            resetPropertySuggestions(sender, { input: '/wp reset v', cursor: 11, start: 10, remaining: 'v' }),
        ).toEqual(['visibility-range']);
    });

    it('suggests matching online players for access grants', () => {
        const { getAllPlayers, runtime, sender } = setup(true);
        const alex = { getName: () => 'Alex', [Symbol.dispose]: vi.fn() } as unknown as Player;
        const alice = { getName: () => 'Alice', [Symbol.dispose]: vi.fn() } as unknown as Player;
        getAllPlayers.mockReturnValue([alex, alice]);

        expect(
            onlinePlayerNameSuggestions(runtime)(sender, {
                input: '/wp access grant player Spawn Al',
                cursor: 32,
                start: 30,
                remaining: 'Al',
            }),
        ).toEqual(['Alex', 'Alice']);
        expect(alex[Symbol.dispose]).toHaveBeenCalledOnce();
        expect(alice[Symbol.dispose]).toHaveBeenCalledOnce();
    });

    it('revokes a player grant by UUID while that player is offline', () => {
        const { catalog, handlers, sender } = setup(true);
        const offlineId = '55555555-5555-4555-8555-555555555555';
        catalog.create({
            id: waypointId,
            name: 'Base',
            dimension: 'world',
            position: { x: 0, y: 64, z: 0 },
            access: { mode: 'restricted', grants: [{ type: 'player', playerId: offlineId }] },
        });

        expect(
            handlers['wp access revoke player <name> <player>'](sender, {
                name: 'Base',
                player: offlineId.toUpperCase(),
            }),
        ).toEqual(['Access grant removed.']);
        expect(catalog.getByName('Base')?.access.grants).toEqual([]);
    });

    it('points to the UUID when revoking by the name of an offline player', () => {
        const { catalog, handlers, sender } = setup(true);
        catalog.create({ id: waypointId, name: 'Base', dimension: 'world', position: { x: 0, y: 64, z: 0 } });

        expect(handlers['wp access revoke player <name> <player>'](sender, { name: 'Base', player: 'Steve' })).toEqual([
            {
                text: 'That player is not online; use the UUID shown by /wp access list.',
                tone: 'error',
            },
        ]);
    });

    it('suggests the granted player UUIDs of the waypoint being revoked', () => {
        const { catalog, getAllPlayers, runtime, sender } = setup(true);
        getAllPlayers.mockReturnValue([]);
        const grantedId = '55555555-5555-4555-8555-555555555555';
        catalog.create({
            id: waypointId,
            name: 'Home Base',
            dimension: 'world',
            position: { x: 0, y: 64, z: 0 },
            access: { mode: 'restricted', grants: [{ type: 'player', playerId: grantedId }] },
        });
        const input = '/wp access revoke player "Home Base" 5';

        expect(
            onlinePlayerNameSuggestions(runtime)(sender, {
                input,
                cursor: input.length,
                start: input.length - 1,
                remaining: '5',
            }),
        ).toEqual([grantedId]);
    });

    it('explains why a grant is invalid', () => {
        const { catalog, handlers, sender } = setup(true);
        catalog.create({ id: waypointId, name: 'Base', dimension: 'world', position: { x: 0, y: 64, z: 0 } });

        expect(
            handlers['wp access grant permission <name> <permission>'](sender, { name: 'Base', permission: 'vip' }),
        ).toEqual([{ text: expect.stringContaining('namespace:node'), tone: 'error' }]);
        expect(handlers['wp access grant group <name> <group>'](sender, { name: 'Base', group: 'VIP' })).toEqual([
            { text: expect.stringContaining('lowercase'), tone: 'error' },
        ]);
        expect(catalog.getByName('Base')?.access.grants).toEqual([]);
    });

    it('reports unavailable storage from the access commands', () => {
        const { runtime, sender } = setup(true);
        const files = new MemoryFiles();
        files.put('waypoints.json', 'not json');
        const handlers = commandHandlers({
            ...runtime,
            catalog: new WaypointCatalog(new WaypointStore(files, new MemoryLogger())),
        });
        const storageError = [{ text: expect.stringContaining('storage is unavailable'), tone: 'error' }];

        expect(handlers['wp access list <name>'](sender, { name: 'Spawn' })).toEqual(storageError);
        expect(handlers['wp access public <name>'](sender, { name: 'Spawn' })).toEqual(storageError);
        expect(
            handlers['wp access grant permission <name> <permission>'](sender, { name: 'Spawn', permission: 'a:b' }),
        ).toEqual(storageError);
    });

    it('refuses waypoint management without the admin permission, even for operators', () => {
        const { catalog, handlers, sender } = setup(true, undefined, false);

        expect(handlers['wp create <name>'](sender, { name: 'Spawn' })).toEqual([
            { text: 'You do not have permission to manage waypoints.', tone: 'error' },
        ]);
        expect(catalog.list()).toEqual([]);
    });

    it('lets a player with the admin permission manage waypoints without operator status', () => {
        const { catalog, handlers, sender } = setup(false, undefined, true);

        expect(handlers['wp create <name>'](sender, { name: 'Spawn' })).toEqual(['Created waypoint Spawn.']);
        expect(catalog.getByName('Spawn')).toBeDefined();
    });

    it('lets the console manage waypoints with commands that need no position', () => {
        const { catalog, consoleSender, handlers } = setup();
        catalog.create({ id: waypointId, name: 'Spawn', dimension: 'world', position: { x: 0, y: 64, z: 0 } });

        expect(handlers['wp set label <name> <label>'](consoleSender, { name: 'Spawn', label: 'Hub' })).toEqual([
            'Updated label for Spawn.',
        ]);
        expect(handlers['wp access public <name>'](consoleSender, { name: 'Spawn' })).toEqual(['Waypoint is public.']);
        expect(handlers['wp disable <name>'](consoleSender, { name: 'Spawn' })).toEqual(['Disabled waypoint Spawn.']);
        expect(handlers['wp get <name>'](consoleSender, { name: 'Spawn' })).toEqual([
            expect.stringContaining('Enabled: false; access: public'),
        ]);
        expect(handlers['wp rename <name> <newName>'](consoleSender, { name: 'Spawn', newName: 'Hub' })).toEqual([
            'Renamed waypoint Spawn to Hub.',
        ]);
        expect(handlers['wp delete <name>'](consoleSender, { name: 'Hub' })).toEqual(['Deleted waypoint Hub.']);
        expect(catalog.list()).toEqual([]);
    });

    it('still needs a player for commands that use the sender position or world', () => {
        const { catalog, consoleSender, handlers } = setup();
        const playerOnly = [{ text: 'This command can only be used by a player.', tone: 'error' }];

        expect(handlers['wp create <name>'](consoleSender, { name: 'Spawn' })).toEqual(playerOnly);
        expect(handlers['wp create <name> <x> <y> <z>'](consoleSender, { name: 'Spawn', x: 0, y: 64, z: 0 })).toEqual(
            playerOnly,
        );
        expect(catalog.list()).toEqual([]);
    });

    it('sets an icon from the console using the raw console command input', () => {
        const { catalog, consoleSender, handlers } = setup(false, 'pumpkin_pie');
        catalog.create({ id: waypointId, name: 'Pumpkin', dimension: 'world', position: { x: 0, y: 64, z: 0 } });

        expect(handlers['wp set icon <name> <item>'](consoleSender, { name: 'Pumpkin', item: '' })).toEqual([
            'Updated icon for Pumpkin.',
        ]);
        expect(catalog.getByName('Pumpkin')?.icon).toBe('minecraft:pumpkin_pie');
    });

    it('reloads waypoint records from disk for server operators', () => {
        const { catalog, files, handlers, sender } = setup(true);
        catalog.create({ id: waypointId, name: 'Old Home', dimension: 'world', position: { x: 1, y: 2, z: 3 } });
        const diskData = JSON.parse(files.text('waypoints.json') ?? 'null') as {
            waypoints: Array<{ name: string }>;
        };
        const diskWaypoint = diskData.waypoints[0];
        if (diskWaypoint === undefined) throw new Error('Expected a waypoint in the saved file');
        diskWaypoint.name = 'Disk Home';
        files.writeFile('waypoints.json', new TextEncoder().encode(JSON.stringify(diskData)));

        expect(handlers['wp reload'](sender)).toEqual(['Reloaded waypoints from disk.']);
        expect(catalog.list().map(({ name }) => name)).toEqual(['Disk Home']);
    });

    it('creates a shared waypoint at the player exact position and current world', () => {
        const { catalog, handlers, player, sender, world } = setup(true);

        expect(handlers['wp create <name>'](sender, { name: 'Spawn' })).toEqual(['Created waypoint Spawn.']);
        expect(catalog.getByName('spawn')).toMatchObject({
            id: waypointId,
            name: 'Spawn',
            dimension: 'world',
            position: { x: 12.375, y: 64.5, z: -8.25 },
            enabled: true,
            access: { mode: 'restricted', grants: [] },
        });
        expect(world[Symbol.dispose]).toHaveBeenCalledOnce();
        expect(player[Symbol.dispose]).toHaveBeenCalledOnce();
    });

    it('keeps targeting by waypoint name after changing its display label', () => {
        const { catalog, handlers, sender } = setup(true);
        catalog.create({ id: waypointId, name: 'Bert', dimension: 'world', position: { x: 0, y: 64, z: 0 } });

        expect(handlers['wp set label <name> <label>'](sender, { name: 'Bert', label: 'Taylor' })).toEqual([
            'Updated label for Bert.',
        ]);
        expect(handlers['wp set color <name> <hex>'](sender, { name: 'Bert', hex: '00ff00' })).toEqual([
            'Updated color for Bert.',
        ]);
        expect(catalog.getByName('Bert')).toMatchObject({ name: 'Bert', label: 'Taylor', color: '#00FF00' });
        expect(catalog.getByName('Taylor')).toBeUndefined();
    });

    it('resets the property named before the waypoint name', () => {
        const { catalog, handlers, sender } = setup(true);
        catalog.create({ id: waypointId, name: 'Bert', dimension: 'world', position: { x: 0, y: 64, z: 0 } });
        catalog.update('Bert', { color: '#112233' });

        expect(handlers['wp reset <property> <name>'](sender, { property: 'color', name: 'Bert' })).toEqual([
            'Reset color for Bert.',
        ]);
        expect(catalog.getByName('Bert')?.color).toBe('#FFFFFF');
    });

    it.each(['access', 'enabled'])('refuses to reset %s, which have their own commands', (property) => {
        const { catalog, handlers, sender } = setup(true);
        const grants = [{ type: 'player' as const, playerId }];
        catalog.create({
            id: waypointId,
            name: 'Bert',
            dimension: 'world',
            position: { x: 0, y: 64, z: 0 },
            enabled: false,
            access: { mode: 'public', grants },
        });

        expect(handlers['wp reset <property> <name>'](sender, { property, name: 'Bert' })).toEqual([
            { text: 'That property cannot be reset.', tone: 'error' },
        ]);
        expect(catalog.getByName('Bert')).toMatchObject({ enabled: false, access: { mode: 'public', grants } });
    });

    it('resets visibility-range using its command name for the camel-cased field', () => {
        const { catalog, handlers, sender } = setup(true);
        catalog.create({
            id: waypointId,
            name: 'Bert',
            dimension: 'world',
            position: { x: 0, y: 64, z: 0 },
            visibilityRange: 32,
        });

        expect(handlers['wp reset <property> <name>'](sender, { property: 'visibility-range', name: 'Bert' })).toEqual([
            'Reset visibility-range for Bert.',
        ]);
        expect(catalog.getByName('Bert')?.visibilityRange).toBeUndefined();
    });

    it.each([
        ['minecraft:golden_apple', 'minecraft:golden_apple'],
        ['golden_apple', 'minecraft:golden_apple'],
    ])('stores item identifier %s as %s', (item, expectedIcon) => {
        const { catalog, handlers, sender } = setup(true);
        catalog.create({ id: waypointId, name: 'Bert', dimension: 'world', position: { x: 0, y: 64, z: 0 } });

        expect(handlers['wp set icon <name> <item>'](sender, { name: 'Bert', item })).toEqual([
            'Updated icon for Bert.',
        ]);
        expect(catalog.getByName('Bert')?.icon).toBe(expectedIcon);
    });

    it('uses the raw command event input when Pumpkin drops the parsed item argument', () => {
        const { catalog, handlers, sender } = setup(true, 'minecraft:pumpkin_pie');
        catalog.create({ id: waypointId, name: 'Pumpkin', dimension: 'world', position: { x: 0, y: 64, z: 0 } });

        expect(handlers['wp set icon <name> <item>'](sender, { name: 'Pumpkin', item: '' })).toEqual([
            'Updated icon for Pumpkin.',
        ]);
        expect(catalog.getByName('Pumpkin')?.icon).toBe('minecraft:pumpkin_pie');
    });

    it('shows only enabled waypoints the player can access and hides missing-record differences', () => {
        const { catalog, handlers, sender } = setup(false);
        catalog.create({ id: waypointId, name: 'Private', dimension: 'world', position: { x: 1, y: 64, z: 2 } });
        catalog.create({
            id: '33333333-3333-4333-8333-333333333333',
            name: 'Public',
            dimension: 'world',
            position: { x: 4, y: 65, z: -3 },
            access: { mode: 'public', grants: [] },
        });
        catalog.create({
            id: '44444444-4444-4444-8444-444444444444',
            name: 'Closed',
            dimension: 'world',
            position: { x: 0, y: 64, z: 0 },
            access: { mode: 'public', grants: [] },
        });
        catalog.setEnabled('Closed', false);

        expect(handlers['wp list'](sender)).toEqual(['Public — world (4, 65, -3)']);
        const privateInfo = handlers['wp info <name>'](sender, { name: 'Private' });
        const missingInfo = handlers['wp info <name>'](sender, { name: 'Missing' });
        const disabledInfo = handlers['wp info <name>'](sender, { name: 'Closed' });
        expect(privateInfo).toEqual([{ text: 'Waypoint not found or you do not have access.', tone: 'error' }]);
        expect(missingInfo).toEqual(privateInfo);
        expect(disabledInfo).toEqual(privateInfo);
    });

    it('teleports an authorized player to the exact destination while preserving their facing', () => {
        const { catalog, handlers, player, sender, server, world } = setup(false);
        catalog.create({
            id: waypointId,
            name: 'Market',
            dimension: 'world',
            position: { x: 10.25, y: 71.5, z: -4.75 },
            access: { mode: 'public', grants: [] },
        });

        expect(handlers['wp tp <name>'](sender, { name: 'Market' })).toEqual(['Teleported to Market.']);
        expect(player.teleport).toHaveBeenCalledWith([10.25, 71.5, -4.75], 135, -12, world);
        expect(server.getWorldByName).toHaveBeenCalledWith('world');
        expect(world[Symbol.dispose]).toHaveBeenCalledOnce();
    });
});
