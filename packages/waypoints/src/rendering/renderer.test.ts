import type { ClientboundPacket } from 'pumpkin:plugin/java-packets@0.1.0';
import { describe, expect, it } from 'vitest';
import { createWaypoint, type Waypoint } from '../waypoints/model.ts';
import type { WaypointHudRenderer, WaypointHudViewer } from './renderer.ts';
import { createWaypointHudTextJson } from './renderer.ts';

const ownerId = '11111111-1111-4111-8111-111111111111';
const allowedId = '22222222-2222-4222-8222-222222222222';
const deniedId = '33333333-3333-4333-8333-333333333333';
const waypointId = '44444444-4444-4444-8444-444444444444';

const rendererModule = await import('./renderer.ts').catch(() => ({}) as typeof import('./renderer.ts'));
const WaypointHudRendererConstructor = rendererModule.WaypointHudRenderer as
    | (new (options?: {
          depth?: number;
          onError?: (viewerId: string, error: unknown) => void;
      }) => WaypointHudRenderer)
    | undefined;

function createRenderer(options?: {
    depth?: number;
    onError?: (viewerId: string, error: unknown) => void;
}): WaypointHudRenderer {
    if (WaypointHudRendererConstructor === undefined) throw new Error('Waypoint HUD renderer is unavailable.');
    return new WaypointHudRendererConstructor(options);
}

describe('WaypointHudRenderer', () => {
    it('sends restricted display packets only to viewers allowed by the waypoint ACL', () => {
        expect(WaypointHudRendererConstructor).toBeTypeOf('function');
        const renderer = createRenderer();
        const allowed = makeViewer(allowedId);
        const denied = makeViewer(deniedId);

        renderer.renderViewer(allowed.viewer, [
            waypoint({ access: { mode: 'restricted', grants: [{ type: 'player', playerId: allowedId }] } })
        ]);
        renderer.renderViewer(denied.viewer, [
            waypoint({ access: { mode: 'restricted', grants: [{ type: 'player', playerId: allowedId }] } })
        ]);

        expect(allowed.packets.map(({ tag }) => tag)).toEqual(['c-spawn-entity', 'c-set-entity-metadata']);
        expect(denied.packets).toEqual([]);
    });

    it('lets operators render restricted waypoints', () => {
        const renderer = createRenderer();
        const client = makeViewer(deniedId);
        const operator = { ...client.viewer, isOperator: true };

        renderer.renderViewer(operator, [
            waypoint({ access: { mode: 'restricted', grants: [{ type: 'player', playerId: allowedId }] } })
        ]);

        expect(client.packets.map(({ tag }) => tag)).toEqual(['c-spawn-entity', 'c-set-entity-metadata']);
    });

    it('keeps the default display close to the player camera', () => {
        const renderer = createRenderer();
        const client = makeViewer(ownerId);

        renderer.renderViewer(client.viewer, [waypoint()]);

        const spawn = client.packets.find(({ tag }) => tag === 'c-spawn-entity');
        if (spawn === undefined) throw new Error('Expected a text display spawn packet.');
        const position = packetValue(spawn).position as readonly number[];
        expect(
            Math.hypot(position[0] ?? Infinity, (position[1] ?? Infinity) - 65.62, position[2] ?? Infinity)
        ).toBeLessThan(4);
    });

    it('moves a camera-projected display with the player and updates its text when distance changes', () => {
        const renderer = createRenderer();
        const client = makeViewer(ownerId);
        const destination = waypoint({ position: { x: 0, y: 65.62, z: 20 } });

        renderer.renderViewer(client.viewer, [destination]);
        renderer.renderViewer(client.viewer, [destination]);
        expect(client.packets.map(({ tag }) => tag)).toEqual(['c-spawn-entity', 'c-set-entity-metadata']);

        client.viewer.camera = { position: { x: 0, y: 65.62, z: 1 }, yaw: 0, pitch: 0 };
        renderer.renderViewer(client.viewer, [destination]);
        expect(client.packets.map(({ tag }) => tag)).toEqual([
            'c-spawn-entity',
            'c-set-entity-metadata',
            'c-update-entity-pos'
        ]);
        const movement = client.packets.at(-1);
        if (movement === undefined) throw new Error('Expected an entity movement packet.');
        expect(packetValue(movement).delta).toEqual([0, 0, 4096]);

        client.viewer.camera = { position: { x: 0, y: 65.62, z: 2 }, yaw: 0, pitch: 0 };
        renderer.renderViewer(client.viewer, [destination]);
        const secondMovement = client.packets.at(-1);
        if (secondMovement === undefined) throw new Error('Expected a second entity movement packet.');
        expect(packetValue(secondMovement).delta).toEqual([0, 0, 4096]);

        client.viewer.position = { x: 0, y: 64, z: 19 };
        renderer.renderViewer(client.viewer, [destination]);
        expect(client.packets.at(-1)?.tag).toBe('c-set-entity-metadata');
    });

    it('ignores tiny stationary camera jitter below the packet resolution', () => {
        const renderer = createRenderer();
        const client = makeViewer(ownerId);
        const destination = waypoint({ position: { x: 10, y: 65.62, z: 10 } });

        renderer.renderViewer(client.viewer, [destination]);
        client.viewer.camera = { position: client.viewer.camera.position, yaw: 0.02, pitch: 0 };
        renderer.renderViewer(client.viewer, [destination]);

        expect(client.packets.map(({ tag }) => tag)).toEqual(['c-spawn-entity', 'c-set-entity-metadata']);
    });

    it('stabilizes head rotation while standing still and follows it while walking', () => {
        const renderer = createRenderer();
        const client = makeViewer(ownerId);
        const destination = waypoint({ position: { x: 10, y: 65.62, z: 10 } });

        renderer.renderViewer(client.viewer, [destination]);
        client.viewer.camera = { position: client.viewer.camera.position, yaw: 20, pitch: 60 };
        renderer.renderViewer(client.viewer, [destination]);

        const stationaryMovement = client.packets.at(-1);
        if (stationaryMovement?.tag !== 'c-update-entity-pos') {
            throw new Error('Expected the smoothed stationary camera update.');
        }
        expect(stationaryMovement.val.delta[1]).toBe(0);
        expect(Math.hypot(stationaryMovement.val.delta[0], stationaryMovement.val.delta[2])).toBeLessThan(500);

        client.viewer.position = { x: 0.1, y: 64, z: 0 };
        client.viewer.camera = { position: { x: 0.1, y: 65.62, z: 0 }, yaw: 20, pitch: 60 };
        renderer.renderViewer(client.viewer, [destination]);

        const walkingMovement = client.packets.at(-1);
        if (walkingMovement?.tag !== 'c-update-entity-pos') {
            throw new Error('Expected the camera to follow while the player moves.');
        }
        expect(Math.hypot(walkingMovement.val.delta[0], walkingMovement.val.delta[2])).toBeGreaterThan(500);
    });

    it('re-spawns a display when a same-dimension move exceeds the relative packet range', () => {
        const renderer = createRenderer();
        const client = makeViewer(ownerId);
        const destination = waypoint({ position: { x: 0, y: 65.62, z: 20 } });

        renderer.renderViewer(client.viewer, [destination]);
        client.packets.length = 0;
        client.viewer.camera = { position: { x: 0, y: 65.62, z: 10 }, yaw: 0, pitch: 0 };
        renderer.renderViewer(client.viewer, [destination]);

        expect(client.packets.map(({ tag }) => tag)).toEqual([
            'c-remove-entities',
            'c-spawn-entity',
            'c-set-entity-metadata'
        ]);
        const spawn = client.packets[1];
        if (spawn === undefined) throw new Error('Expected the display to be respawned.');
        expect(packetValue(spawn).position).toEqual([0, 65.62, 13]);
    });

    it('shows the colored label and rounded distance in the HUD component', () => {
        const destination = waypoint({ label: 'North Gate', color: '#12ABEF' });
        expect(JSON.parse(createWaypointHudTextJson(destination, 12.6))).toEqual({
            text: '',
            extra: [
                { text: 'North Gate', color: '#12ABEF', bold: true },
                { text: ' (13m)', color: '#FFFFFF' }
            ]
        });
    });

    it('allocates unique negative IDs to multiple displays in one client entity table', () => {
        const renderer = createRenderer();
        const client = makeViewer(ownerId);
        renderer.renderViewer(client.viewer, [
            waypoint({ position: { x: 1, y: 64, z: 10 } }),
            waypoint({ id: '55555555-5555-4555-8555-555555555555', name: 'Harbor', position: { x: -1, y: 64, z: 12 } })
        ]);

        const ids = client.packets
            .filter(({ tag }) => tag === 'c-spawn-entity')
            .map((packet) => packetValue(packet).entityId);
        expect(ids).toEqual([-1_500_000_000, -1_500_000_001]);
    });

    it('separates overlapping labels and keeps their layout independent of input order', () => {
        const first = waypoint({ name: 'Market', position: { x: 0, y: 64, z: 0 } });
        const second = waypoint({
            id: '55555555-5555-4555-8555-555555555555',
            name: 'Harbor',
            position: { x: 0, y: 64, z: 0 }
        });
        const left = makeViewer(ownerId);
        const right = makeViewer(ownerId);

        createRenderer().renderViewer(left.viewer, [first, second]);
        createRenderer().renderViewer(right.viewer, [second, first]);

        const spawnPositions = (client: ReturnType<typeof makeViewer>) =>
            client.packets
                .filter(({ tag }) => tag === 'c-spawn-entity')
                .map((packet) => packetValue(packet).position);
        const leftPositions = spawnPositions(left);
        const rightPositions = spawnPositions(right);

        expect(leftPositions).toEqual(rightPositions);
        expect(leftPositions).toHaveLength(2);
        const firstPosition = leftPositions[0] as number[];
        const secondPosition = leftPositions[1] as number[];
        expect(Math.abs((firstPosition[1] ?? 0) - (secondPosition[1] ?? 0))).toBeGreaterThan(0.25);
    });

    it('removes a display immediately after access is revoked', () => {
        const renderer = createRenderer();
        const client = makeViewer(allowedId);
        const allowed = waypoint({ access: { mode: 'restricted', grants: [{ type: 'player', playerId: allowedId }] } });

        renderer.renderViewer(client.viewer, [allowed]);
        renderer.renderViewer(client.viewer, [waypoint({ ...allowed, access: { mode: 'restricted', grants: [] } })]);

        expect(client.packets.map(({ tag }) => tag)).toEqual([
            'c-spawn-entity',
            'c-set-entity-metadata',
            'c-remove-entities'
        ]);
        const removePacket = client.packets.at(-1);
        if (removePacket === undefined) throw new Error('Expected an entity removal packet.');
        expect(packetValue(removePacket).entityIds).toHaveLength(1);
    });

    it('recreates displays after a dimension change because the client discarded its entity table', () => {
        const renderer = createRenderer();
        const client = makeViewer(ownerId);
        const destination = waypoint({ position: { x: 0, y: 64, z: 20 } });

        renderer.renderViewer(client.viewer, [destination]);
        client.packets.length = 0;
        client.viewer.dimension = 'nether';
        renderer.renderViewer(client.viewer, [destination]);
        expect(client.packets).toEqual([]);

        client.viewer.dimension = 'overworld';
        renderer.renderViewer(client.viewer, [destination]);
        expect(client.packets.map(({ tag }) => tag)).toEqual(['c-spawn-entity', 'c-set-entity-metadata']);
    });

    it('cleans up a leaving viewer and continues after another viewer packet sink fails', () => {
        const errors: string[] = [];
        const renderer = createRenderer({ onError: (viewerId) => errors.push(viewerId) });
        const failing = makeViewer(deniedId, true);
        const staying = makeViewer(ownerId);
        const destination = waypoint({ access: { mode: 'public', grants: [] } });

        renderer.renderViewer(failing.viewer, [destination]);
        renderer.renderViewer(staying.viewer, [destination]);
        renderer.removeViewer(staying.viewer.id, staying.viewer.sendPacket);

        expect(errors).toEqual([deniedId]);
        expect(staying.packets.map(({ tag }) => tag)).toEqual([
            'c-spawn-entity',
            'c-set-entity-metadata',
            'c-remove-entities'
        ]);
    });
});

function waypoint(overrides: Partial<Waypoint> = {}): Waypoint {
    return createWaypoint({
        id: waypointId,
        name: 'Market',
        dimension: 'overworld',
        position: { x: 0, y: 64, z: 10 },
        access: { mode: 'public', grants: [] },
        ...overrides
    });
}

function makeViewer(
    id: string,
    fail = false
): {
    readonly viewer: WaypointHudViewer;
    readonly packets: ClientboundPacket[];
} {
    const packets: ClientboundPacket[] = [];
    let nextUuid = 0n;
    const viewer: WaypointHudViewer = {
        id,
        dimension: 'overworld',
        position: { x: 0, y: 64, z: 0 },
        camera: { position: { x: 0, y: 65.62, z: 0 }, yaw: 0, pitch: 0 },
        isOperator: false,
        hasPermission: () => false,
        createEntityUuid: () => ({ high: 0n, low: ++nextUuid }),
        encodeTextComponent: () => Uint8Array.of(10, 0, 0),
        sendPacket: (packet) => {
            if (fail) throw new Error('packet sink failed');
            packets.push(packet);
        }
    };
    return { viewer, packets };
}

function packetValue(packet: ClientboundPacket): Record<string, unknown> {
    if ('val' in packet) return packet.val as Record<string, unknown>;
    throw new TypeError('Expected a tagged packet value.');
}
