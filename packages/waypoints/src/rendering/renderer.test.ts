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
          onError?: (viewerId: string, error: unknown) => void;
      }) => WaypointHudRenderer)
    | undefined;

function createRenderer(options?: { onError?: (viewerId: string, error: unknown) => void }): WaypointHudRenderer {
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

    it('places a distant waypoint along its world direction at a bounded HUD distance', () => {
        const renderer = createRenderer();
        const client = makeViewer(ownerId);
        const destination = waypoint({ position: { x: 0, y: 64, z: 50 } });

        renderer.renderViewer(client.viewer, [destination]);
        const position = readDisplayPosition(client);
        expect(Math.hypot(position.x, position.y - 65.62, position.z)).toBeCloseTo(8, 3);
        expect(position.x).toBe(0);
        expect(position.z).toBeGreaterThan(7.99);
        expect((position.y - 65.62) / position.z).toBeCloseTo(0.38 / 50, 5);
    });

    it('keeps a waypoint behind the viewer nearby instead of removing or reprojecting it', () => {
        const renderer = createRenderer();
        const client = makeViewer(ownerId);
        const destination = waypoint({ position: { x: 0, y: 64, z: -50 } });

        renderer.renderViewer(client.viewer, [destination]);
        for (let tick = 0; tick < 10; tick += 1) renderer.renderViewer(client.viewer, [destination]);
        const position = readDisplayPosition(client);
        expect(position.z).toBeLessThan(-7.99);
        expect(Math.hypot(position.x, position.y - 65.62, position.z)).toBeCloseTo(8, 3);
        expect(client.packets.map(({ tag }) => tag)).toEqual(['c-spawn-entity', 'c-set-entity-metadata']);
    });

    it('keeps a sideways waypoint at a finite HUD distance', () => {
        const client = makeViewer(ownerId);
        createRenderer().renderViewer(client.viewer, [waypoint({ position: { x: 50, y: 64, z: 0 } })]);
        const position = readDisplayPosition(client);
        expect(position.x).toBeGreaterThan(7.99);
        expect(position.z).toBe(0);
        expect(Math.hypot(position.x, position.y - 65.62)).toBeCloseTo(8, 3);
    });

    it('does not emit display packets from an invalid eye sample', () => {
        const client = makeViewer(ownerId);
        client.viewer.eyePosition = { x: 0, y: Number.NaN, z: 0 };
        createRenderer().renderViewer(client.viewer, [waypoint()]);
        expect(client.packets).toEqual([]);
    });

    it('strongly damps a vertical bump while moving the HUD origin with the current eye position', () => {
        const renderer = createRenderer();
        const client = makeViewer(ownerId);
        const destination = waypoint({ position: { x: 0, y: 64, z: 50 } });

        renderer.renderViewer(client.viewer, [destination]);
        const initialHeight = readDisplayPosition(client).y - 65.62;
        client.viewer.position = { x: 0, y: 64.8, z: 0 };
        client.viewer.eyePosition = { x: 0, y: 66.42, z: 0 };
        renderer.renderViewer(client.viewer, [destination]);
        const position = readDisplayPosition(client);
        expect(Math.abs(position.y - 66.42 - initialHeight) / 8).toBeLessThan(0.002);
        expect(position.y).toBeGreaterThan(66.4);
        expect(Math.hypot(position.x, position.y - 66.42, position.z)).toBeCloseTo(8, 3);
    });

    it('follows a steep vertical destination faster while eventually settling at its true direction', () => {
        const ordinary = makeViewer(ownerId);
        const elevated = makeViewer(allowedId);
        const renderer = createRenderer();
        const ordinaryWaypoint = waypoint({ position: { x: 0, y: 64, z: 30 } });
        const elevatedWaypoint = waypoint({ position: { x: 0, y: 94, z: 30 } });
        const elevation = (client: ReturnType<typeof makeViewer>) => {
            const position = readDisplayPosition(client);
            return Math.atan2(position.y - client.viewer.eyePosition.y, position.z);
        };
        renderer.renderViewer(ordinary.viewer, [ordinaryWaypoint]);
        renderer.renderViewer(elevated.viewer, [elevatedWaypoint]);
        const ordinaryStart = elevation(ordinary);
        const elevatedStart = elevation(elevated);
        for (const client of [ordinary, elevated]) {
            client.viewer.position = { x: 0, y: 65, z: 0 };
            client.viewer.eyePosition = { x: 0, y: 66.62, z: 0 };
        }
        renderer.renderViewer(ordinary.viewer, [ordinaryWaypoint]);
        renderer.renderViewer(elevated.viewer, [elevatedWaypoint]);
        expect(Math.abs(elevation(elevated) - elevatedStart)).toBeGreaterThan(
            Math.abs(elevation(ordinary) - ordinaryStart) * 2
        );
        for (let tick = 0; tick < 200; tick += 1) renderer.renderViewer(elevated.viewer, [elevatedWaypoint]);
        expect(elevation(elevated)).toBeCloseTo(Math.atan2(29.38, 30), 3);
        const packetsAtRest = elevated.packets.length;
        for (let tick = 0; tick < 5; tick += 1) renderer.renderViewer(elevated.viewer, [elevatedWaypoint]);
        expect(elevated.packets).toHaveLength(packetsAtRest);
    });

    it('tracks straight movement without reversing direction or oscillating its bearing', () => {
        const renderer = createRenderer();
        const client = makeViewer(ownerId);
        const destination = waypoint({ position: { x: 0, y: 64, z: 100 } });
        renderer.renderViewer(client.viewer, [destination]);
        let previousElevation = readDisplayPosition(client).y - client.viewer.eyePosition.y;
        for (let tick = 1; tick <= 80; tick += 1) {
            client.viewer.position = { x: 0, y: 64, z: tick * 0.25 };
            client.viewer.eyePosition = { x: 0, y: 65.62, z: tick * 0.25 };
            renderer.renderViewer(client.viewer, [destination]);
            const position = readDisplayPosition(client);
            expect(position.x).toBe(0);
            expect(Math.hypot(position.y - 65.62, position.z - tick * 0.25)).toBeCloseTo(8, 3);
            expect(position.y - 65.62).toBeGreaterThanOrEqual(previousElevation - 1 / 4096);
            previousElevation = position.y - 65.62;
        }
        for (const packet of client.packets) {
            if (packet.tag === 'c-update-entity-pos') expect(packet.val.delta[2]).toBeGreaterThan(0);
        }
    });

    it('blends into and out of the world anchor without jumps or entity replacements', () => {
        const renderer = createRenderer();
        const client = makeViewer(ownerId);
        const destination = waypoint({ position: { x: 0, y: 64, z: 20 } });
        renderer.renderViewer(client.viewer, [destination]);
        let previous = readDisplayPosition(client);
        for (let step = 1; step <= 80; step += 1) {
            client.viewer.position = { x: 0, y: 64, z: step * 0.25 };
            client.viewer.eyePosition = { x: 0, y: 65.62, z: step * 0.25 };
            renderer.renderViewer(client.viewer, [destination]);
            const position = readDisplayPosition(client);
            expect(Math.hypot(position.y - previous.y, position.z - previous.z)).toBeLessThan(0.6);
            expect(position.z).toBeGreaterThanOrEqual(previous.z - 1 / 4096);
            previous = position;
        }
        expect(readDisplayPosition(client).z).toBeCloseTo(20, 3);
        expect(readDisplayPosition(client).y).toBeCloseTo(66, 3);
        expect(client.packets.filter(({ tag }) => tag === 'c-spawn-entity')).toHaveLength(1);
        expect(client.packets.some(({ tag }) => tag === 'c-remove-entities')).toBe(false);
        client.packets.length = 0;
        client.viewer.position = { x: 0, y: 64, z: 19 };
        client.viewer.eyePosition = { x: 0, y: 65.62, z: 19 };
        renderer.renderViewer(client.viewer, [destination]);
        expect(client.packets.some(({ tag }) => tag === 'c-update-entity-pos')).toBe(false);

        // Keep the original spawn ledger to reconstruct movement during the retreat.
        const retreat = makeViewer(allowedId);
        retreat.viewer.position = { x: 0, y: 64, z: 19 };
        retreat.viewer.eyePosition = { x: 0, y: 65.62, z: 19 };
        renderer.renderViewer(retreat.viewer, [destination]);
        previous = readDisplayPosition(retreat);
        for (let step = 75; step >= 0; step -= 1) {
            retreat.viewer.position = { x: 0, y: 64, z: step * 0.25 };
            retreat.viewer.eyePosition = { x: 0, y: 65.62, z: step * 0.25 };
            renderer.renderViewer(retreat.viewer, [destination]);
            const position = readDisplayPosition(retreat);
            expect(Math.hypot(position.y - previous.y, position.z - previous.z)).toBeLessThan(0.6);
            previous = position;
        }
        const end = readDisplayPosition(retreat);
        expect(Math.hypot(end.x, end.y - 65.62, end.z)).toBeCloseTo(8, 3);
        expect(retreat.packets.filter(({ tag }) => tag === 'c-spawn-entity')).toHaveLength(1);
        expect(retreat.packets.some(({ tag }) => tag === 'c-remove-entities')).toBe(false);
    });

    it('recreates the nearby HUD after a same-world teleport beyond the relative packet range', () => {
        const renderer = createRenderer();
        const client = makeViewer(ownerId);
        const destination = waypoint({ position: { x: 0, y: 64, z: 100 } });
        renderer.renderViewer(client.viewer, [destination]);
        client.packets.length = 0;
        client.viewer.position = { x: 0, y: 64, z: 20 };
        client.viewer.eyePosition = { x: 0, y: 65.62, z: 20 };
        renderer.renderViewer(client.viewer, [destination]);
        expect(client.packets.map(({ tag }) => tag)).toEqual([
            'c-remove-entities',
            'c-spawn-entity',
            'c-set-entity-metadata'
        ]);
        expect(readDisplayPosition(client).z).toBeGreaterThan(27.99);
        expect(readDisplayPosition(client).z).toBeLessThan(28.01);
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

    it('sends scale changes while preserving apparent text size near the world anchor', () => {
        const renderer = createRenderer();
        const client = makeViewer(ownerId);
        const destination = waypoint({ position: { x: 0, y: 64, z: 20 } });
        for (let z = 0; z <= 20; z += 0.25) {
            client.viewer.position = { x: 0, y: 64, z };
            client.viewer.eyePosition = { x: 0, y: 65.62, z };
            renderer.renderViewer(client.viewer, [destination]);
            const position = readDisplayPosition(client);
            const distance = Math.hypot(position.x, position.y - 65.62, position.z - z);
            expect(readDisplayScale(client) / distance).toBeCloseTo(0.18, 2);
        }
        expect(client.packets.filter(({ tag }) => tag === 'c-spawn-entity')).toHaveLength(1);
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

    it('spaces collocated labels with a stable order independent of input ordering', () => {
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
        const [firstPosition, secondPosition] = leftPositions as number[][];
        expect(Math.abs((firstPosition?.[1] ?? 0) - (secondPosition?.[1] ?? 0))).toBeGreaterThan(0.3);
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
        eyePosition: { x: 0, y: 65.62, z: 0 },
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

function readDisplayScale(client: ReturnType<typeof makeViewer>): number {
    let scale = 1;
    for (const packet of client.packets) {
        if (packet.tag !== 'c-set-entity-metadata') continue;
        const bytes = packet.val.metadata;
        const index = bytes.findIndex((byte, offset) => byte === 12 && bytes[offset + 1] === 39);
        if (index >= 0) scale = new DataView(bytes.buffer, bytes.byteOffset + index + 2, 12).getFloat32(0, false);
    }
    return scale;
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
