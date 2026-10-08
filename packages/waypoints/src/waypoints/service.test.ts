import { MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it } from 'vitest';
import { type WaypointActor, WaypointService } from './service.ts';
import { WaypointStore } from './store.ts';

const owner: WaypointActor = { playerId: '22222222-2222-4222-8222-222222222222', isOperator: false };
const visitor: WaypointActor = { playerId: '33333333-3333-4333-8333-333333333333', isOperator: false };
const operator: WaypointActor = { playerId: '44444444-4444-4444-8444-444444444444', isOperator: true };
const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '55555555-5555-4555-8555-555555555555';

function service(files = new MemoryFiles()) {
    return { files, service: new WaypointService(new WaypointStore(files, new MemoryLogger())) };
}

describe(WaypointService.name, () => {
    it('returns the same result for a missing and inaccessible waypoint ID', () => {
        const { service: waypoints } = service();
        waypoints.create(owner, { id: firstId, name: 'Hidden', dimension: 'world', x: 1, y: 2, z: 3 });

        expect(waypoints.getFor(visitor, firstId)).toBeUndefined();
        expect(waypoints.getFor(visitor, secondId)).toBeUndefined();
        expect(waypoints.setVisibility(visitor, firstId, 'public')).toBe(
            waypoints.setVisibility(visitor, secondId, 'public')
        );
    });

    it('filters private points from listings and exposes them to their owner or operator', () => {
        const { service: waypoints } = service();
        waypoints.create(owner, { id: firstId, name: 'Home', dimension: 'world', x: 1, y: 2, z: 3 });

        expect(waypoints.listFor(visitor, 'world')).toEqual([]);
        expect(waypoints.listFor(owner, 'world')?.map(({ id }) => id)).toEqual([firstId]);
        expect(waypoints.getFor(operator, firstId)?.id).toBe(firstId);
    });

    it('persists UUID invitations and applies public visibility without granting mutation rights', () => {
        const { files, service: waypoints } = service();
        waypoints.create(owner, { id: firstId, name: 'Home', dimension: 'world', x: 1, y: 2, z: 3 });
        expect(waypoints.setVisibility(owner, firstId, 'allowlist')).toBe('updated');
        expect(waypoints.addRecipient(owner, firstId, visitor.playerId)).toBe('updated');
        expect(
            new WaypointService(new WaypointStore(files, new MemoryLogger())).getFor(visitor, firstId)?.ownerId
        ).toBe(owner.playerId);
        expect(waypoints.setVisibility(owner, firstId, 'public')).toBe('updated');
        expect(waypoints.getFor(visitor, firstId)?.visibility).toBe('public');
        expect(waypoints.setVisibility(visitor, firstId, 'private')).toBe('not-found');
    });

    it('allows an operator to administer any point and keeps locator settings owner-scoped', () => {
        const { service: waypoints } = service();
        waypoints.create(owner, { id: firstId, name: 'Home', dimension: 'world', x: 1, y: 2, z: 3 });

        expect(waypoints.setLocatorEnabled(visitor, firstId, true)).toBe('not-found');
        expect(waypoints.setLocatorEnabled(operator, firstId, true)).toBe('updated');
        expect(waypoints.setLocatorColor(owner, firstId, '#00ff00')).toBe('updated');
        expect(waypoints.setJavaStyle(owner, firstId, 'minecraft:default')).toBe('updated');
        expect(waypoints.getFor(owner, firstId)?.locatorBar).toEqual({
            enabled: true,
            color: '#00FF00',
            javaStyleId: 'minecraft:default'
        });
    });

    it('returns unavailable and refuses creation when the store is invalid', () => {
        const files = new MemoryFiles().put('waypoints.json', '{');
        const waypoints = new WaypointService(new WaypointStore(files, new MemoryLogger()));

        expect(waypoints.create(owner, { id: firstId, name: 'Home', dimension: 'world', x: 1, y: 2, z: 3 })).toBe(
            'unavailable'
        );
        expect(waypoints.listFor(owner)).toBeUndefined();
    });
});
