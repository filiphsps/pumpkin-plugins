import type { CommandSender } from 'pumpkin:plugin/command@0.1.0';
import type { Player } from 'pumpkin:plugin/player@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it, vi } from 'vitest';
import { WaypointCatalog } from '../waypoints/catalog.ts';
import { WaypointStore } from '../waypoints/store.ts';
import { commandHandlers } from './handlers.ts';

vi.mock('@pumpkin-plugins/plugin-kit/host', () => ({
    hostLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const playerId = '22222222-2222-4222-8222-222222222222';
const waypointId = '11111111-1111-4111-8111-111111111111';

function setup(isOperator = false, pendingItemIconInput?: string) {
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
        [Symbol.dispose]: vi.fn()
    } as unknown as Player;
    const opManager = { isOp: vi.fn(() => isOperator), [Symbol.dispose]: vi.fn() };
    const server = {
        getOpManager: () => opManager,
        getWorldByName: vi.fn((name: string) => (name === 'world' ? world : undefined)),
        getPlayerByName: vi.fn()
    } as unknown as Server;
    const sender = { asPlayer: () => player, hasPermission: vi.fn(() => true) } as unknown as CommandSender;
    const handlers = commandHandlers({
        server,
        catalog,
        createWaypointId: () => waypointId,
        uuidToString: () => playerId,
        uuidFromString: () => ({ high: 1n, low: 2n }) as never,
        consumePendingItemIconInput: () => pendingItemIconInput,
        validateItemIcon: () => true
    });
    return { catalog, files, handlers, opManager, player, sender, server, world };
}

describe('/wp handlers', () => {
    it('uses Pumpkin operator status instead of a grantable command permission', () => {
        const { catalog, handlers, opManager, player, sender } = setup(false);
        const run = (
            handlers as unknown as Record<string, (sender: CommandSender, args: object) => readonly unknown[]>
        )['wp create <name>'];

        expect(run(sender, { name: 'Spawn' })).toEqual([
            { text: 'Only server operators can manage waypoints.', tone: 'error' }
        ]);
        expect(opManager.isOp).toHaveBeenCalledWith(player.getId());
        expect(player.hasPermission).not.toHaveBeenCalled();
        expect(catalog.list()).toEqual([]);
    });

    it('creates a shared waypoint at the player exact position and current world', () => {
        const { catalog, handlers, player, sender, world } = setup(true);
        const run = (
            handlers as unknown as Record<string, (sender: CommandSender, args: object) => readonly unknown[]>
        )['wp create <name>'];

        expect(run(sender, { name: 'Spawn' })).toEqual(['Created waypoint Spawn.']);
        expect(catalog.getByName('spawn')).toMatchObject({
            id: waypointId,
            name: 'Spawn',
            dimension: 'world',
            position: { x: 12.375, y: 64.5, z: -8.25 },
            enabled: true,
            access: { mode: 'restricted', grants: [] }
        });
        expect(world[Symbol.dispose]).toHaveBeenCalledOnce();
        expect(player[Symbol.dispose]).toHaveBeenCalledOnce();
    });

    it('keeps targeting by waypoint name after changing its display label', () => {
        const { catalog, handlers, sender } = setup(true);
        catalog.create({ id: waypointId, name: 'Bert', dimension: 'world', position: { x: 0, y: 64, z: 0 } });
        const run = handlers as unknown as Record<string, (sender: CommandSender, args?: object) => readonly unknown[]>;

        expect(run['wp set label <name> <label>']?.(sender, { name: 'Bert', label: 'Taylor' })).toEqual([
            'Updated label for Bert.'
        ]);
        expect(run['wp set color <name> <hex>']?.(sender, { name: 'Bert', hex: '00ff00' })).toEqual([
            'Updated color for Bert.'
        ]);
        expect(catalog.getByName('Bert')).toMatchObject({ name: 'Bert', label: 'Taylor', color: '#00FF00' });
        expect(catalog.getByName('Taylor')).toBeUndefined();
    });

    it.each([
        ['minecraft:golden_apple', 'minecraft:golden_apple'],
        ['golden_apple', 'minecraft:golden_apple']
    ])('stores item identifier %s as %s', (item, expectedIcon) => {
        const { catalog, handlers, sender } = setup(true);
        catalog.create({ id: waypointId, name: 'Bert', dimension: 'world', position: { x: 0, y: 64, z: 0 } });
        const run = handlers as unknown as Record<string, (sender: CommandSender, args?: object) => readonly unknown[]>;

        expect(run['wp set icon <name> <item>']?.(sender, { name: 'Bert', item })).toEqual(['Updated icon for Bert.']);
        expect(catalog.getByName('Bert')?.icon).toBe(expectedIcon);
    });

    it('uses the raw command event input when Pumpkin drops the parsed item argument', () => {
        const { catalog, handlers, sender } = setup(true, 'minecraft:pumpkin_pie');
        catalog.create({ id: waypointId, name: 'Pumpkin', dimension: 'world', position: { x: 0, y: 64, z: 0 } });
        const run = handlers as unknown as Record<string, (sender: CommandSender, args?: object) => readonly unknown[]>;

        expect(run['wp set icon <name> <item>']?.(sender, { name: 'Pumpkin', item: '' })).toEqual([
            'Updated icon for Pumpkin.'
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
            access: { mode: 'public', grants: [] }
        });
        catalog.create({
            id: '44444444-4444-4444-8444-444444444444',
            name: 'Closed',
            dimension: 'world',
            position: { x: 0, y: 64, z: 0 },
            access: { mode: 'public', grants: [] }
        });
        catalog.setEnabled('Closed', false);
        const run = handlers as unknown as Record<string, (sender: CommandSender, args?: object) => readonly unknown[]>;

        expect(run['wp list']?.(sender)).toEqual(['Public — world (4, 65, -3)']);
        const privateInfo = run['wp info <name>']?.(sender, { name: 'Private' });
        const missingInfo = run['wp info <name>']?.(sender, { name: 'Missing' });
        const disabledInfo = run['wp info <name>']?.(sender, { name: 'Closed' });
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
            access: { mode: 'public', grants: [] }
        });
        const run = (
            handlers as unknown as Record<string, (sender: CommandSender, args: object) => readonly unknown[]>
        )['wp tp <name>'];

        expect(run(sender, { name: 'Market' })).toEqual(['Teleported to Market.']);
        expect(player.teleport).toHaveBeenCalledWith([10.25, 71.5, -4.75], 135, -12, world);
        expect(server.getWorldByName).toHaveBeenCalledWith('world');
        expect(world[Symbol.dispose]).toHaveBeenCalledOnce();
    });
});
