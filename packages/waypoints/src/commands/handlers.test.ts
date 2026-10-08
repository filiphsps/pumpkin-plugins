import type { CommandSender } from 'pumpkin:plugin/command@0.1.0';
import type { Player } from 'pumpkin:plugin/player@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { commandInfos } from '@pumpkin-plugins/docs';
import { buildCommands, type CommandHost } from '@pumpkin-plugins/plugin-kit/commands';
import {
    FakeCommandHost,
    type FakeNode,
    type FakeSender,
    MemoryFiles,
    MemoryLogger
} from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it, vi } from 'vitest';
import { MapDeliveryService, XaeroShareAdapter } from '../adapters/map-delivery.ts';
import { info } from '../info.ts';
import { WaypointService } from '../waypoints/service.ts';
import { WaypointStore } from '../waypoints/store.ts';
import { commandHandlers } from './handlers.ts';
import { ADMIN_PERMISSION, commands } from './spec.ts';

const ownerId = '22222222-2222-4222-8222-222222222222';
const visitorId = '33333333-3333-4333-8333-333333333333';
const waypointId = '11111111-1111-4111-8111-111111111111';

function setup() {
    const files = new MemoryFiles();
    const waypoints = new WaypointService(new WaypointStore(files, new MemoryLogger()));
    const recipientMessages = vi.fn();
    const ownerPlayer = fakePlayer(ownerId, 'Alex', [-0.1, 64.9, -16.01], 'world');
    const visitorPlayer = fakePlayer(visitorId, 'Blair', [0, 64, 0], 'world');
    const online = new Map([
        ['Alex', ownerPlayer],
        ['Blair', visitorPlayer]
    ]);
    const server = { getPlayerByName: (name: string) => online.get(name) } as unknown as Server;
    const mapDelivery = new MapDeliveryService(waypoints, { 'xaero-share': new XaeroShareAdapter() });
    const host = new FakeCommandHost();
    const runtime = {
        server,
        waypoints,
        mapDelivery,
        createWaypointId: () => waypointId,
        uuidToString: (uuid: { high: number }) => (uuid.high === 1 ? ownerId : visitorId),
        sendSystemMessage: (_player: Player, message: string) => recipientMessages(message)
    };
    const handlers = commandHandlers(runtime);
    const built = buildCommands<CommandSender, typeof commands>(
        host as unknown as CommandHost<CommandSender>,
        commands,
        handlers
    );
    return { files, waypoints, host, root: built[0]?.node as FakeNode, ownerPlayer, recipientMessages };
}

function fakePlayer(id: string, name: string, position: [number, number, number], worldName: string): Player {
    return {
        getId: () => ({ high: id === ownerId ? 1 : 2, low: 3 }),
        getName: () => name,
        getPosition: () => position,
        getWorld: () => ({ getName: () => worldName, [Symbol.dispose]: vi.fn() }),
        hasPermission: (permission: string) => permission === ADMIN_PERMISSION && id === ownerId
    } as unknown as Player;
}

function sender(player: Player | null, isOperator = false): FakeSender {
    return {
        lines: [],
        errors: [],
        asPlayer: () => player,
        hasPermission: (_server: Server, permission: string) => permission === ADMIN_PERMISSION && isOperator
    } as unknown as FakeSender;
}

describe('/wp commands', () => {
    it('registers exactly the usages generated into plugin info', () => {
        const { host, root } = setup();
        expect(host.usages(root).sort()).toEqual((info.commands ?? []).map(({ usage }) => usage).sort());
        expect(info.commands).toEqual(commandInfos(commands));
    });

    it('marks a private waypoint at floored player coordinates', () => {
        const { host, root, waypoints } = setup();
        const result = host.runAs(
            root,
            ['wp', 'mark', '<name>'],
            { name: 'Mine entrance' },
            sender(fakePlayer(ownerId, 'Alex', [-0.1, 64.9, -16.01], 'world'))
        );

        expect(result.lines[0]).toContain('Created waypoint');
        expect(waypoints.getFor({ playerId: ownerId, isOperator: false }, waypointId)).toMatchObject({
            name: 'Mine entrance',
            dimension: 'world',
            x: -1,
            y: 64,
            z: -17,
            visibility: 'private',
            locatorBar: { enabled: false }
        });
    });

    it('uses one response for missing and inaccessible waypoint IDs', () => {
        const { host, root, waypoints } = setup();
        waypoints.create(
            { playerId: ownerId, isOperator: false },
            {
                id: waypointId,
                name: 'Private',
                dimension: 'world',
                x: 1,
                y: 2,
                z: 3
            }
        );

        const inaccessible = host.runAs(
            root,
            ['wp', 'show', '<id>'],
            { id: waypointId },
            sender(fakePlayer(visitorId, 'Blair', [0, 0, 0], 'world'))
        );
        const missing = host.runAs(
            root,
            ['wp', 'show', '<id>'],
            { id: '55555555-5555-4555-8555-555555555555' },
            sender(fakePlayer(visitorId, 'Blair', [0, 0, 0], 'world'))
        );

        expect(inaccessible.lines).toEqual(missing.lines);
        expect(inaccessible.lines[0]).toContain('not found or you do not have access');
    });

    it('sends readable fallback coordinates only to recipients who may access the waypoint', () => {
        const { host, root, waypoints, recipientMessages } = setup();
        waypoints.create(
            { playerId: ownerId, isOperator: false },
            {
                id: waypointId,
                name: 'Home',
                dimension: 'world',
                x: 10,
                y: 64,
                z: -4
            }
        );

        const denied = host.runAs(
            root,
            ['wp', 'send-to', '<id>', '<player>', '<adapter>'],
            { id: waypointId, player: 'Blair', adapter: 'xaero-share' },
            sender(fakePlayer(ownerId, 'Alex', [0, 0, 0], 'world'))
        );
        expect(denied.errors[0]).toContain('not found or you do not have access');
        expect(recipientMessages).not.toHaveBeenCalled();

        waypoints.setVisibility({ playerId: ownerId, isOperator: false }, waypointId, 'public');
        const sent = host.runAs(
            root,
            ['wp', 'send-to', '<id>', '<player>', '<adapter>'],
            { id: waypointId, player: 'Blair', adapter: 'xaero-share' },
            sender(fakePlayer(ownerId, 'Alex', [0, 0, 0], 'world'))
        );
        expect(recipientMessages).toHaveBeenCalledWith(expect.stringContaining('10, 64, -4'));
        expect(sent.lines.some((line) => line.includes('import is unavailable'))).toBe(true);
    });

    it('rejects player-position commands from the console with a clear error', () => {
        const { host, root } = setup();
        const result = host.runAs(root, ['wp', 'mark', '<name>'], { name: 'Home' }, sender(null, true));
        expect(result.errors).toEqual(['This command can only be used by a player.']);
    });

    it('reports failed persistence without claiming a waypoint was created', () => {
        const { files, host, root, waypoints } = setup();
        vi.spyOn(files, 'writeFile').mockImplementation(() => {
            throw new Error('disk full');
        });

        const result = host.runAs(
            root,
            ['wp', 'mark', '<name>'],
            { name: 'Home' },
            sender(fakePlayer(ownerId, 'Alex', [0, 64, 0], 'world'))
        );

        expect(result.errors).toEqual([
            'Waypoint storage is unavailable or the change could not be saved; check the server log. No changes were made.'
        ]);
        expect(result.lines).not.toContain('Created waypoint Home.');
        expect(waypoints.listFor({ playerId: ownerId, isOperator: false })).toEqual([]);
    });
});
