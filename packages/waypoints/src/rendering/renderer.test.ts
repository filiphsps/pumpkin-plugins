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
    it('sends each configured icon below its label and refreshes icon-only edits', () => {
        const renderer = createRenderer();
        const client = makeViewer(ownerId);
        const first = waypoint({ icon: 'minecraft:pumpkin_pie' });
        const second = waypoint({
            id: '55555555-5555-4555-8555-555555555555',
            name: 'Flowers',
            icon: 'minecraft:poppy'
        });
        renderer.renderViewer(client.viewer, [first, second]);
        const metadata = client.packets.filter((packet) => packet.tag === 'c-set-entity-metadata');
        const contents = metadata.map((packet) => new TextDecoder().decode(packet.val.metadata));
        expect(contents[0]).toContain('minecraft:item/pumpkin_pie');
        expect(contents[1]).toContain('minecraft:block/poppy');
        expect(contents.every((text) => text.includes('\n'))).toBe(true);
        client.packets.length = 0;
        renderer.renderViewer(client.viewer, [waypoint({ ...first, icon: 'minecraft:apple' }), second]);
        expect(client.packets.map(({ tag }) => tag)).toEqual(['c-set-entity-metadata']);
        const update = client.packets[0];
        if (update?.tag !== 'c-set-entity-metadata') throw new Error('Expected an icon update.');
        expect(new TextDecoder().decode(update.val.metadata)).toContain('minecraft:item/apple');
        client.packets.length = 0;
        renderer.renderViewer(client.viewer, [waypoint({ ...first, icon: undefined }), second]);
        expect(client.packets.map(({ tag }) => tag)).toEqual(['c-set-entity-metadata']);
    });

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
        const firstDelta = packetValue(movement).delta as number[];
        expect(firstDelta[2]).toBe(4096);
        expect(Math.abs(firstDelta[1] ?? Infinity)).toBeLessThan(100);

        client.viewer.camera = { position: { x: 0, y: 65.62, z: 2 }, yaw: 0, pitch: 0 };
        renderer.renderViewer(client.viewer, [destination]);
        const secondMovement = client.packets.at(-1);
        if (secondMovement === undefined) throw new Error('Expected a second entity movement packet.');
        const secondDelta = packetValue(secondMovement).delta as number[];
        expect(secondDelta[2]).toBe(4096);
        expect(Math.abs(secondDelta[1] ?? Infinity)).toBeLessThan(100);

        client.viewer.position = { x: 0, y: 64, z: 19 };
        renderer.renderViewer(client.viewer, [destination]);
        expect(client.packets.at(-1)?.tag).toBe('c-set-entity-metadata');
    });

    it('blends the HUD marker into a stable world anchor as the player reaches the waypoint', () => {
        const renderer = createRenderer();
        const client = makeViewer(ownerId);
        const destination = waypoint({ position: { x: 0, y: 64, z: 20 } });

        renderer.renderViewer(client.viewer, [destination]);
        const positions: number[] = [];
        for (let z = 1; z <= 20; z += 1) {
            client.viewer.position = { x: 0, y: 64, z };
            client.viewer.camera = { position: { x: 0, y: 65.62, z }, yaw: 0, pitch: 0 };
            renderer.renderViewer(client.viewer, [destination]);
            positions.push(readDisplayPosition(client).z);
        }

        const entityChanges = client.packets
            .filter(({ tag }) => tag === 'c-spawn-entity' || tag === 'c-remove-entities')
            .map(({ tag }) => tag);
        expect(entityChanges).toEqual(['c-spawn-entity']);
        expect(positions.at(-1)).toBeCloseTo(20, 3);
        expect(readDisplayPosition(client).y).toBeCloseTo(66, 3);
        for (let index = 1; index < positions.length; index += 1) {
            expect(Math.abs((positions[index] ?? 0) - (positions[index - 1] ?? 0))).toBeLessThan(3);
        }
    });

    it('eases ordinary screen-height movement while following an elevated waypoint faster', async () => {
        const ordinary = makeViewer(ownerId);
        const elevated = makeViewer(allowedId);
        const ordinaryWaypoint = waypoint({ position: { x: 0, y: 64, z: 30 } });
        const elevatedWaypoint = waypoint({
            id: '55555555-5555-4555-8555-555555555555',
            position: { x: 0, y: 74, z: 30 }
        });
        const ordinaryRenderer = createRenderer();
        const elevatedRenderer = createRenderer();

        ordinaryRenderer.renderViewer(ordinary.viewer, [ordinaryWaypoint]);
        elevatedRenderer.renderViewer(elevated.viewer, [elevatedWaypoint]);
        const { cameraPlaneCoordinates } = await import('./layout.ts');
        const screenHeight = (client: ReturnType<typeof makeViewer>) =>
            cameraPlaneCoordinates(client.viewer.camera, readDisplayPosition(client)).vertical;
        const ordinaryStart = screenHeight(ordinary);
        const elevatedStart = screenHeight(elevated);

        for (const client of [ordinary, elevated]) {
            client.viewer.position = { x: 0.1, y: 64, z: 0 };
            client.viewer.camera = { position: { x: 0.1, y: 65.62, z: 0 }, yaw: 0, pitch: 30 };
        }
        ordinaryRenderer.renderViewer(ordinary.viewer, [ordinaryWaypoint]);
        elevatedRenderer.renderViewer(elevated.viewer, [elevatedWaypoint]);

        const ordinaryMovement = Math.abs(screenHeight(ordinary) - ordinaryStart);
        const elevatedMovement = Math.abs(screenHeight(elevated) - elevatedStart);
        expect(ordinaryMovement).toBeLessThan(0.3);
        expect(elevatedMovement).toBeGreaterThan(ordinaryMovement * 2);
    });

    it('eases horizontal screen movement when the player shifts from side to side', async () => {
        const renderer = createRenderer();
        const client = makeViewer(ownerId);
        const destination = waypoint({ position: { x: 0, y: 64, z: 30 } });
        const { cameraPlaneCoordinates, projectWaypointOnCameraPlane } = await import('./layout.ts');
        const screenSide = () => cameraPlaneCoordinates(client.viewer.camera, readDisplayPosition(client)).horizontal;

        renderer.renderViewer(client.viewer, [destination]);
        const initial = screenSide();
        client.viewer.position = { x: 0.5, y: 64, z: 0 };
        client.viewer.camera = { position: { x: 0.5, y: 65.62, z: 0 }, yaw: 0, pitch: 0 };
        renderer.renderViewer(client.viewer, [destination]);
        const shifted = screenSide();
        const rawProjected = projectWaypointOnCameraPlane(client.viewer.camera, { x: 0, y: 66, z: 30 }, 3);
        if (rawProjected === undefined) throw new Error('Expected a forward waypoint projection.');
        const rawShift = Math.abs(cameraPlaneCoordinates(client.viewer.camera, rawProjected).horizontal - initial);

        client.viewer.position = { x: 0, y: 64, z: 0 };
        client.viewer.camera = { position: { x: 0, y: 65.62, z: 0 }, yaw: 0, pitch: 0 };
        renderer.renderViewer(client.viewer, [destination]);
        const returned = screenSide();

        expect(Math.abs(shifted - initial)).toBeLessThan(rawShift * 0.5);
        expect(Math.abs(returned - shifted)).toBeLessThan(Math.abs(shifted - initial));
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

    it('ignores small eye-position noise while the player is stationary', () => {
        const renderer = createRenderer();
        const client = makeViewer(ownerId);
        const destination = waypoint({ position: { x: 10, y: 65.62, z: 10 } });

        renderer.renderViewer(client.viewer, [destination]);
        client.viewer.camera = { position: { x: 0.001, y: 65.62, z: 0 }, yaw: 0, pitch: 0 };
        renderer.renderViewer(client.viewer, [destination]);

        expect(client.packets.map(({ tag }) => tag)).toEqual(['c-spawn-entity', 'c-set-entity-metadata']);
    });

    it('ignores small stationary yaw noise while the player is stationary', () => {
        const renderer = createRenderer();
        const client = makeViewer(ownerId);
        const destination = waypoint({ position: { x: 10, y: 65.62, z: 10 } });

        renderer.renderViewer(client.viewer, [destination]);
        client.viewer.camera = { position: client.viewer.camera.position, yaw: 0.1, pitch: 0 };
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
        const spawnPosition = packetValue(spawn).position as readonly number[];
        expect(spawnPosition[0]).toBe(0);
        expect(Math.abs((spawnPosition[1] ?? Infinity) - 65.62)).toBeLessThan(0.5);
        expect(spawnPosition[2]).toBe(13);
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
            client.packets.filter(({ tag }) => tag === 'c-spawn-entity').map((packet) => packetValue(packet).position);
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
        encodeTextComponent: () => Uint8Array.of(10, 0),
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

function readDisplayPosition(client: ReturnType<typeof makeViewer>): { x: number; y: number; z: number } {
    let position: [number, number, number] | undefined;
    for (const packet of client.packets) {
        const value = packetValue(packet);
        if (packet.tag === 'c-spawn-entity') {
            position = [...(value.position as [number, number, number])];
        } else if (packet.tag === 'c-update-entity-pos' && position !== undefined) {
            const delta = value.delta as [number, number, number];
            position = [
                (position[0] ?? 0) + (delta[0] ?? 0) / 4096,
                (position[1] ?? 0) + (delta[1] ?? 0) / 4096,
                (position[2] ?? 0) + (delta[2] ?? 0) / 4096
            ];
        }
    }
    if (position === undefined) throw new Error('Expected a waypoint display position.');
    return { x: position[0], y: position[1], z: position[2] };
}
