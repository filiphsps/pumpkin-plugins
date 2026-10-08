import { MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it, vi } from 'vitest';
import { type WaypointActor, WaypointService } from '../waypoints/service.ts';
import { WaypointStore } from '../waypoints/store.ts';
import { MapDeliveryService, XaeroShareAdapter } from './map-delivery.ts';

const owner: WaypointActor = { playerId: '22222222-2222-4222-8222-222222222222', isOperator: false };
const visitor: WaypointActor = { playerId: '33333333-3333-4333-8333-333333333333', isOperator: false };
const recipient = { ...visitor, sendSystemMessage: vi.fn() };
const waypointId = '11111111-1111-4111-8111-111111111111';

function setup() {
    const files = new MemoryFiles();
    const waypoints = new WaypointService(new WaypointStore(files, new MemoryLogger()));
    waypoints.create(owner, { id: waypointId, name: 'Hidden', dimension: 'world', x: 1, y: 2, z: 3 });
    const delivery = new MapDeliveryService(waypoints, { 'xaero-share': new XaeroShareAdapter() });
    return { waypoints, delivery };
}

describe('map delivery', () => {
    it('does not deliver or reveal inaccessible waypoint IDs', () => {
        const { delivery } = setup();

        expect(delivery.send(visitor, recipient, waypointId, 'xaero-share')).toEqual({ status: 'not-found' });
        expect(delivery.send(visitor, recipient, '55555555-5555-4555-8555-555555555555', 'xaero-share')).toEqual({
            status: 'not-found'
        });
        expect(recipient.sendSystemMessage).not.toHaveBeenCalled();
    });

    it('reports Xaero import as unavailable until the current client share format is verified', () => {
        const { waypoints, delivery } = setup();
        waypoints.setVisibility(owner, waypointId, 'public');

        expect(delivery.send(visitor, recipient, waypointId, 'xaero-share')).toMatchObject({
            status: 'unavailable',
            reason: expect.stringContaining('verified')
        });
        expect(recipient.sendSystemMessage).not.toHaveBeenCalled();
    });
});
