import type { JavaPacket, Uuid } from 'pumpkin:plugin/player@0.1.0';
import { MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it } from 'vitest';
import { type WaypointActor, WaypointService } from '../waypoints/service.ts';
import { WaypointStore } from '../waypoints/store.ts';
import { JavaLocatorBarOutput, toJavaWaypointPacket } from './java-locator-bar.ts';

const owner: WaypointActor = { playerId: '22222222-2222-4222-8222-222222222222', isOperator: false };
const visitor: WaypointActor = { playerId: '33333333-3333-4333-8333-333333333333', isOperator: false };
const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '55555555-5555-4555-8555-555555555555';
const parseUuid = (id: string): Uuid | undefined => (id.includes('-') ? { high: 1, low: 2 } : undefined);

function setup() {
    const service = new WaypointService(new WaypointStore(new MemoryFiles(), new MemoryLogger()));
    const output = new JavaLocatorBarOutput(service, parseUuid);
    return { service, output };
}

function player(id = visitor.playerId, dimension = 'world') {
    const packets: JavaPacket[] = [];
    return {
        playerId: id,
        dimension,
        isJava: true,
        isOperator: false,
        packets,
        sendPacket: (packet: JavaPacket) => packets.push(packet)
    };
}

function waypoint(service: WaypointService, id: string, dimension = 'world') {
    service.create(owner, { id, name: 'Home', dimension, x: -3, y: 64, z: 8 });
    service.setVisibility(owner, id, 'public');
    service.setLocatorEnabled(owner, id, true);
}

function locatorPacket(packet: JavaPacket) {
    if (packet.tag !== 'c-waypoint') throw new Error(`Expected c-waypoint, received ${packet.tag}`);
    return packet.val;
}

function packetAt(client: ReturnType<typeof player>, index = 0) {
    const packet = client.packets[index];
    if (packet === undefined) throw new Error(`Expected packet ${index} to be sent`);
    return locatorPacket(packet);
}

describe('Java Locator Bar output', () => {
    it('maps default markers without an icon and custom style/color to c-waypoint packets', () => {
        const plain = toJavaWaypointPacket({ ...makeWaypoint(), locatorBar: { enabled: false } }, 'track', {
            high: 1,
            low: 2
        });
        expect(locatorPacket(plain)).toMatchObject({
            operation: 'track',
            waypoint: { target: { tag: 'position', val: [-3, 64, 8] } }
        });
        expect(locatorPacket(plain).waypoint.icon).toBeUndefined();

        const customized = toJavaWaypointPacket(
            { ...makeWaypoint(), locatorBar: { enabled: true, color: '#AABBCC', javaStyleId: 'example:home' } },
            'update',
            { high: 1, low: 2 }
        );
        expect(locatorPacket(customized)).toMatchObject({
            operation: 'update',
            waypoint: { icon: { style: 'example:home', color: 0xaabbcc } }
        });
    });

    it('tracks only enabled Java waypoints visible in the recipient dimension', () => {
        const { service, output } = setup();
        waypoint(service, firstId);
        waypoint(service, secondId, 'nether');
        const client = player();

        output.reconcile(client);

        expect(client.packets).toHaveLength(1);
        expect(packetAt(client).waypoint.identifier).toEqual({ high: 1, low: 2 });
        expect(packetAt(client).waypoint.target).toEqual({ tag: 'position', val: [-3, 64, 8] });
        expect(output.key).toBe('java:locator-bar');
    });

    it('untracks markers after allowlist revocation and waypoint deletion', () => {
        const { service, output } = setup();
        service.create(owner, { id: firstId, name: 'Private', dimension: 'world', x: 1, y: 2, z: 3 });
        service.setVisibility(owner, firstId, 'allowlist');
        service.addRecipient(owner, firstId, visitor.playerId);
        service.setLocatorEnabled(owner, firstId, true);
        const client = player();
        output.reconcile(client);
        expect(packetAt(client).operation).toBe('track');

        service.removeRecipient(owner, firstId, visitor.playerId);
        output.reconcile(client);
        expect(packetAt(client, 1).operation).toBe('untrack');

        service.setVisibility(owner, firstId, 'public');
        output.reconcile(client);
        service.remove(owner, firstId);
        output.reconcile(client);
        expect(client.packets.map((packet) => locatorPacket(packet).operation)).toEqual([
            'track',
            'untrack',
            'track',
            'untrack'
        ]);
    });

    it('resets tracked state when a Java player changes dimension', () => {
        const { service, output } = setup();
        waypoint(service, firstId, 'world');
        waypoint(service, secondId, 'nether');
        const client = player();
        output.reconcile(client);
        client.dimension = 'nether';

        output.reconcile(client, true);

        expect(client.packets.map((packet) => locatorPacket(packet).operation)).toEqual([
            'track',
            'untrack',
            'untrack',
            'track'
        ]);
    });

    it('clears session markers when the plugin unloads', () => {
        const { service, output } = setup();
        waypoint(service, firstId);
        const client = player();
        output.reconcile(client);

        output.clear(client);

        expect(client.packets.map((packet) => locatorPacket(packet).operation)).toEqual(['track', 'untrack']);
    });

    it('rejects malformed style identifiers and untracks with an empty target', () => {
        expect(() =>
            toJavaWaypointPacket(
                { ...makeWaypoint(), locatorBar: { enabled: true, javaStyleId: 'bad style' } },
                'track',
                { high: 1, low: 2 }
            )
        ).toThrow('Invalid waypoint style ID');
        const packet = toJavaWaypointPacket(makeWaypoint(), 'untrack', { high: 1, low: 2 });
        expect(locatorPacket(packet)).toMatchObject({ operation: 'untrack', waypoint: { target: { tag: 'empty' } } });
    });
});

function makeWaypoint() {
    return {
        id: firstId,
        name: 'Home',
        dimension: 'world',
        x: -3,
        y: 64,
        z: 8,
        ownerId: owner.playerId,
        visibility: 'private' as const,
        allowedPlayerIds: [],
        locatorBar: { enabled: false }
    };
}
