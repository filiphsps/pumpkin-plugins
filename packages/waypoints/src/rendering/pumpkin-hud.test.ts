import type { Player } from 'pumpkin:plugin/player@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WaypointCatalog } from '../waypoints/catalog.ts';
import { WaypointStore } from '../waypoints/store.ts';
import type { WaypointHudService } from './pumpkin-hud.ts';

const viewerId = '11111111-1111-4111-8111-111111111111';
const restrictedId = '22222222-2222-4222-8222-222222222222';
const exactPlayerUuid = { high: 0x123456789abcdef0n, low: 0xfedcba9876543210n };
const generatedEntityUuid = { high: 3n, low: 4n };

const uuidMocks = vi.hoisted(() => ({
    generate: vi.fn(() => ({ high: 3n, low: 4n })),
    encodedTextJson: [] as string[],
    disposedTextComponents: 0,
    toString: vi.fn((id: { high: bigint; low: bigint }) =>
        id.high === 0x123456789abcdef0n
            ? '11111111-1111-4111-8111-111111111111'
            : '22222222-2222-4222-8222-222222222222'
    )
}));

vi.mock('pumpkin:plugin/uuid@0.1.0', () => uuidMocks);
vi.mock('pumpkin:plugin/text@0.1.0', () => ({
    TextComponent: class {
        constructor(private readonly json: string) {}

        static fromJson(json: string) {
            return new this(json);
        }

        encode() {
            uuidMocks.encodedTextJson.push(this.json);
            return Uint8Array.of(10, 0, 0);
        }

        [Symbol.dispose]() {
            uuidMocks.disposedTextComponents += 1;
        }
    }
}));

const serviceModule = await import('./pumpkin-hud.ts').catch(() => ({}) as typeof import('./pumpkin-hud.ts'));
const WaypointHudServiceConstructor = serviceModule.WaypointHudService as
    | (new (
          server: Server,
          catalog: WaypointCatalog,
          options?: { onError?: (viewerId: string, error: unknown) => void }
      ) => WaypointHudService)
    | undefined;

function createService(
    server: Server,
    catalog: WaypointCatalog,
    options?: { onError?: (viewerId: string, error: unknown) => void }
): WaypointHudService {
    if (WaypointHudServiceConstructor === undefined) throw new Error('Waypoint HUD service is unavailable.');
    return new WaypointHudServiceConstructor(server, catalog, options);
}

describe('WaypointHudService', () => {
    beforeEach(() => {
        uuidMocks.encodedTextJson.length = 0;
        uuidMocks.disposedTextComponents = 0;
    });

    it('skips a null Java handle without logging errors or blocking another player', () => {
        const unsupported = makePlayer(restrictedId, 'v-26-3');
        unsupported.player.asJava = () => null as unknown as ReturnType<Player['asJava']>;
        const supported = makePlayer(viewerId, 'v-26-3');
        const server = {
            getAllPlayers: () => [unsupported.player, supported.player],
            getOpManager: () => ({ isOp: () => false, [Symbol.dispose]: vi.fn() })
        } as unknown as Server;
        const catalog = new WaypointCatalog(new WaypointStore(new MemoryFiles(), new MemoryLogger()));
        catalog.create({
            id: '44444444-4444-4444-8444-444444444444',
            name: 'Open',
            dimension: 'overworld',
            position: { x: 0, y: 64, z: 10 },
            access: { mode: 'public', grants: [] }
        });
        const errors: unknown[] = [];
        const service = createService(server, catalog, { onError: (_id, error) => errors.push(error) });
        service.tick();
        service.left(unsupported.player);
        service.unload();
        expect(errors).toEqual([]);
        expect(supported.packets.some(({ tag }) => tag === 'c-spawn-entity')).toBe(true);
        expect(unsupported.packets).toEqual([]);
    });

    it('renders only authorized Minecraft 26.3 viewers and removes their displays on leave', () => {
        expect(WaypointHudServiceConstructor).toBeTypeOf('function');
        const authorized = makePlayer(viewerId, 'v-26-3');
        const unauthorized = makePlayer(restrictedId, 'v-26-3');
        const oldClient = makePlayer('33333333-3333-4333-8333-333333333333', 'v-26-2');
        const players = [authorized.player, unauthorized.player, oldClient.player];
        const opManager = { isOp: vi.fn(() => false), [Symbol.dispose]: vi.fn() };
        const server = {
            getAllPlayers: () => players,
            getOpManager: () => opManager
        } as unknown as Server;
        const catalog = new WaypointCatalog(new WaypointStore(new MemoryFiles(), new MemoryLogger()));
        catalog.create({
            id: '44444444-4444-4444-8444-444444444444',
            name: 'Restricted',
            dimension: 'overworld',
            position: { x: 0, y: 64, z: 10 },
            access: { mode: 'restricted', grants: [{ type: 'player', playerId: viewerId }] }
        });
        const service = createService(server, catalog);

        service.tick();
        service.left(authorized.player);

        expect(authorized.packets.map(({ tag }) => tag)).toEqual([
            'c-spawn-entity',
            'c-set-entity-metadata',
            'c-remove-entities'
        ]);
        expect(unauthorized.packets).toEqual([]);
        expect(oldClient.packets).toEqual([]);
        expect(opManager.isOp).toHaveBeenCalledWith(exactPlayerUuid);
        expect(uuidMocks.toString).toHaveBeenCalled();
        expect(uuidMocks.generate).toHaveBeenCalledOnce();
        expect(uuidMocks.encodedTextJson).toHaveLength(1);
        const encodedText = uuidMocks.encodedTextJson[0];
        if (encodedText === undefined) throw new Error('Expected an encoded HUD component.');
        expect(JSON.parse(encodedText).extra[0]).toMatchObject({ text: 'Restricted', color: '#FFFFFF' });
        expect(JSON.parse(encodedText).extra[1]).toMatchObject({ text: ' (10m)' });
        expect(uuidMocks.disposedTextComponents).toBe(1);
        expect(generatedEntityUuid).toEqual({ high: 3n, low: 4n });
    });

    it('releases online displays and ignores a per-viewer send failure during unload', () => {
        const failing = makePlayer(viewerId, 'v-26-3', true);
        const staying = makePlayer(restrictedId, 'v-26-3');
        const players = [failing.player, staying.player];
        const server = {
            getAllPlayers: () => players,
            getOpManager: () => ({ isOp: () => true, [Symbol.dispose]: vi.fn() })
        } as unknown as Server;
        const catalog = new WaypointCatalog(new WaypointStore(new MemoryFiles(), new MemoryLogger()));
        catalog.create({
            id: '55555555-5555-4555-8555-555555555555',
            name: 'Open',
            dimension: 'overworld',
            position: { x: 0, y: 64, z: 10 },
            access: { mode: 'public', grants: [] }
        });
        const errors: string[] = [];
        const service = createService(server, catalog, { onError: (id) => errors.push(id) });

        service.tick();
        service.unload();

        expect(errors).toContain(viewerId);
        expect(staying.packets.map(({ tag }) => tag)).toEqual([
            'c-spawn-entity',
            'c-set-entity-metadata',
            'c-remove-entities'
        ]);
    });

    it('moves the nearby HUD with the current eye position and refreshes its distance text', () => {
        const client = makePlayer(viewerId, 'v-26-3');
        const server = {
            getAllPlayers: () => [client.player],
            getOpManager: () => ({ isOp: () => false, [Symbol.dispose]: vi.fn() })
        } as unknown as Server;
        const catalog = new WaypointCatalog(new WaypointStore(new MemoryFiles(), new MemoryLogger()));
        catalog.create({
            id: '66666666-6666-4666-8666-666666666666',
            name: 'North',
            dimension: 'overworld',
            position: { x: 0, y: 65.62, z: 20 },
            access: { mode: 'public', grants: [] }
        });
        const service = createService(server, catalog);

        service.tick();
        client.pose.position = [0, 64, 1];
        client.pose.eye = [0, 65.62, 1];
        client.getYaw.mockReturnValue(180);
        client.getPitch.mockReturnValue(45);
        service.tick();

        expect(client.packets.map(({ tag }) => tag)).toEqual([
            'c-spawn-entity',
            'c-set-entity-metadata',
            'c-update-entity-pos',
            'c-set-entity-metadata'
        ]);
        const initial = client.packets[0]?.val.position as number[];
        expect(Math.hypot(initial[0] ?? 0, (initial[1] ?? 0) - 65.62, initial[2] ?? 0)).toBeCloseTo(10.9387, 3);
        const movement = client.packets[2]?.val.delta as number[];
        expect(movement[2]).toBeGreaterThan(2800);
        expect(movement[2]).toBeLessThan(4100);
        expect(uuidMocks.encodedTextJson.at(-1)).toContain('19m');
        expect(client.entity[Symbol.dispose]).toHaveBeenCalledTimes(2);
    });

    it('does not move or replace a HUD marker when the viewer only rotates the camera', () => {
        const client = makePlayer(viewerId, 'v-26-3');
        const server = {
            getAllPlayers: () => [client.player],
            getOpManager: () => ({ isOp: () => false, [Symbol.dispose]: vi.fn() })
        } as unknown as Server;
        const catalog = new WaypointCatalog(new WaypointStore(new MemoryFiles(), new MemoryLogger()));
        catalog.create({
            id: '77777777-7777-4777-8777-777777777777',
            name: 'North',
            dimension: 'overworld',
            position: { x: 10, y: 64, z: 20 },
            access: { mode: 'public', grants: [] }
        });
        const service = createService(server, catalog);
        service.tick();
        client.getYaw.mockReturnValue(180);
        client.getPitch.mockReturnValue(45);
        service.tick();
        client.getYaw.mockReturnValue(-90);
        client.getPitch.mockReturnValue(-80);
        service.tick();
        expect(client.packets.filter(({ tag }) => tag === 'c-spawn-entity')).toHaveLength(1);
        expect(client.packets.some(({ tag }) => tag === 'c-update-entity-pos' || tag === 'c-remove-entities')).toBe(
            false
        );
    });
});

function makePlayer(id: string, version: string, fail = false) {
    const packets: Array<{ tag: string; val: Record<string, unknown> }> = [];
    const playerUuid = id === viewerId ? exactPlayerUuid : { high: 5n, low: 6n };
    const pose = {
        position: [0, 64, 0] as readonly number[],
        eye: [0, 65.62, 0] as readonly number[]
    };
    const java = {
        getVersion: () => version,
        sendPacket: (packet: { tag: string; val: Record<string, unknown> }) => {
            if (fail) throw new Error('client disconnected');
            packets.push(packet);
        },
        [Symbol.dispose]: vi.fn()
    };
    const world = { getName: () => 'overworld', [Symbol.dispose]: vi.fn() };
    const entity = { getEyePosition: () => pose.eye, [Symbol.dispose]: vi.fn() };
    const asEntity = vi.fn(() => entity);
    const getYaw = vi.fn(() => 0);
    const getPitch = vi.fn(() => 0);
    const player = {
        getId: () => playerUuid,
        getName: () => 'Alex',
        asJava: () => java,
        asEntity,
        getPosition: () => pose.position,
        getYaw,
        getPitch,
        getWorld: () => world,
        hasPermission: () => false,
        [Symbol.dispose]: vi.fn()
    } as unknown as Player;
    return { player, packets, java, world, entity, asEntity, getYaw, getPitch, pose };
}
