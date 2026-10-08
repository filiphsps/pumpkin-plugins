import { MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it, vi } from 'vitest';
import { createWaypoint } from './model.ts';
import { WaypointStore } from './store.ts';

const owner = '22222222-2222-4222-8222-222222222222';
const waypointId = '11111111-1111-4111-8111-111111111111';

function waypoint(id = waypointId, name = 'Home') {
    return createWaypoint({ id, name, dimension: 'minecraft:overworld', x: -4, y: 64, z: 9, ownerId: owner });
}

describe(WaypointStore.name, () => {
    it('round trips UUID-keyed records and allows repeated names', () => {
        const files = new MemoryFiles();
        const store = new WaypointStore(files, new MemoryLogger());
        const first = waypoint();
        const second = {
            ...waypoint('33333333-3333-4333-8333-333333333333'),
            locatorBar: { enabled: true, color: '#AABBCC', javaStyleId: 'minecraft:default' }
        };

        expect(store.add(first)).toBe(true);
        expect(store.add(second)).toBe(true);
        expect(files.text('waypoints.json')).toContain('"version":1');

        const reloaded = new WaypointStore(files, new MemoryLogger());
        expect(reloaded.list()).toEqual([first, second]);
    });

    it.each([
        ['malformed JSON', '{"version":'],
        ['unsupported schema', '{"version":2,"waypoints":[] }'],
        ['invalid waypoint record', '{"version":1,"waypoints":[null]}']
    ])('preserves %s and refuses writes', (_label, content) => {
        const files = new MemoryFiles().put('waypoints.json', content);
        const logger = new MemoryLogger();
        const store = new WaypointStore(files, logger);

        expect(store.isAvailable).toBe(false);
        expect(store.add(waypoint())).toBe(false);
        expect(files.text('waypoints.json')).toBe(content);
        expect(logger.of('error')).toHaveLength(1);
    });

    it('keeps in-memory records unchanged when an atomic write fails', () => {
        const files = new MemoryFiles();
        const logger = new MemoryLogger();
        const store = new WaypointStore(files, logger);
        vi.spyOn(files, 'writeFile').mockImplementation(() => {
            throw new Error('disk full');
        });

        expect(() => store.add(waypoint())).toThrow('disk full');
        expect(store.list()).toEqual([]);
        expect(logger.of('error')[0]).toContain('no waypoint changes were applied');
    });

    it('persists locator settings without changing the waypoint identity', () => {
        const files = new MemoryFiles();
        const store = new WaypointStore(files, new MemoryLogger());
        store.add(waypoint());
        const updated = {
            ...waypoint(),
            locatorBar: { enabled: true, color: '#00FF00', javaStyleId: 'minecraft:default' }
        };

        expect(store.update(waypointId, () => updated)).toBe(true);
        expect(new WaypointStore(files, new MemoryLogger()).get(waypointId)?.locatorBar).toEqual(updated.locatorBar);
    });

    it('persists allowlist UUIDs so access survives a store reload', () => {
        const files = new MemoryFiles();
        const store = new WaypointStore(files, new MemoryLogger());
        const allowedPlayerId = '44444444-4444-4444-8444-444444444444';
        const shared = { ...waypoint(), visibility: 'allowlist' as const, allowedPlayerIds: [allowedPlayerId] };
        store.add(shared);

        expect(new WaypointStore(files, new MemoryLogger()).get(waypointId)).toEqual(shared);
    });

    it('rejects malformed resource IDs before writing them', () => {
        const files = new MemoryFiles();
        const store = new WaypointStore(files, new MemoryLogger());
        store.add(waypoint());

        expect(
            store.update(waypointId, (current) => ({
                ...current,
                locatorBar: { enabled: true, javaStyleId: 'not-a-resource-id' }
            }))
        ).toBe(false);
        expect(new WaypointStore(files, new MemoryLogger()).get(waypointId)?.locatorBar.enabled).toBe(false);
    });
});
