import { MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { strFromU8, strToU8 } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { createWaypoint } from './model.ts';
import { WaypointStore } from './store.ts';

const waypointId = '11111111-1111-4111-8111-111111111111';
const ownerId = '22222222-2222-4222-8222-222222222222';
const visitorId = '33333333-3333-4333-8333-333333333333';

function waypoint(id = waypointId, name = 'Home') {
    return createWaypoint({
        id,
        name,
        dimension: 'world',
        position: { x: -4.25, y: 64.5, z: 9.75 }
    });
}

function legacyWaypoint(overrides: Record<string, unknown> = {}) {
    return {
        id: waypointId,
        name: 'Home',
        dimension: 'world',
        x: -4,
        y: 64,
        z: 9,
        ownerId,
        visibility: 'private',
        allowedPlayerIds: [],
        locatorBar: { enabled: true, color: '#ABCDEF', javaStyleId: 'minecraft:default' },
        ...overrides
    };
}

describe(WaypointStore.name, () => {
    it('round trips strict v2 records and rejects duplicate normalized names', () => {
        const files = new MemoryFiles();
        const store = new WaypointStore(files, new MemoryLogger());
        expect(store.add(waypoint())).toBe(true);
        expect(store.add(waypoint('44444444-4444-4444-8444-444444444444', 'home'))).toBe(false);
        expect(files.text('waypoints.json')).toContain('"version": 2');
        expect(new WaypointStore(files, new MemoryLogger()).list()).toEqual([waypoint()]);
    });

    it('writes four-space indented JSON with a trailing newline', () => {
        const files = new MemoryFiles();
        const store = new WaypointStore(files, new MemoryLogger());
        store.add(waypoint());

        expect(files.text('waypoints.json')).toBe(`${JSON.stringify({ version: 2, waypoints: [waypoint()] }, null, 4)}\n`);
    });

    it('writes a v1 backup before migrating all legacy access modes', () => {
        const original = JSON.stringify({
            version: 1,
            waypoints: [
                legacyWaypoint(),
                legacyWaypoint({
                    id: '44444444-4444-4444-8444-444444444444',
                    name: 'Public',
                    visibility: 'public'
                }),
                legacyWaypoint({
                    id: '55555555-5555-4555-8555-555555555555',
                    name: 'Shared',
                    visibility: 'allowlist',
                    allowedPlayerIds: [visitorId]
                })
            ]
        });
        const files = new MemoryFiles().put('waypoints.json', original);
        const store = new WaypointStore(files, new MemoryLogger());

        expect(store.isAvailable).toBe(true);
        expect(files.text('waypoints.v1.json')).toBe(original);
        expect(JSON.parse(files.text('waypoints.json') ?? 'null')).toEqual({
            version: 2,
            waypoints: [
                {
                    ...waypoint(),
                    position: { x: -4, y: 64, z: 9 },
                    access: { mode: 'restricted', grants: [{ type: 'player', playerId: ownerId }] }
                },
                {
                    ...waypoint('44444444-4444-4444-8444-444444444444', 'Public'),
                    position: { x: -4, y: 64, z: 9 },
                    access: { mode: 'public', grants: [] }
                },
                {
                    ...waypoint('55555555-5555-4555-8555-555555555555', 'Shared'),
                    position: { x: -4, y: 64, z: 9 },
                    access: {
                        mode: 'restricted',
                        grants: [
                            { type: 'player', playerId: ownerId },
                            { type: 'player', playerId: visitorId }
                        ]
                    }
                }
            ]
        });
    });

    it('loads, migrates, and serializes without browser encoding globals', () => {
        const original = strToU8(JSON.stringify({ version: 1, waypoints: [legacyWaypoint()] }));
        const files = new MemoryFiles().put('waypoints.json', original);
        vi.stubGlobal('TextDecoder', undefined);
        vi.stubGlobal('TextEncoder', undefined);

        try {
            const store = new WaypointStore(files, new MemoryLogger());

            expect(store.isAvailable).toBe(true);
            expect([...files.readFile('waypoints.v1.json')]).toEqual([...original]);
            expect(JSON.parse(strFromU8(files.readFile('waypoints.json')))).toMatchObject({ version: 2 });
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('suffixes normalized name collisions deterministically during v1 migration', () => {
        const files = new MemoryFiles().put(
            'waypoints.json',
            JSON.stringify({
                version: 1,
                waypoints: [
                    legacyWaypoint(),
                    legacyWaypoint({ id: '44444444-4444-4444-8444-444444444444', name: 'home' })
                ]
            })
        );
        const logger = new MemoryLogger();
        const store = new WaypointStore(files, logger);

        expect(store.list().map(({ name }) => name)).toEqual(['Home', 'home (2)']);
        expect(logger.of('warn')).toHaveLength(1);
    });

    it('preserves malformed, unsupported, and invalid v2 files and refuses writes', () => {
        for (const content of [
            '{"version":',
            '{"version":3,"waypoints":[]}',
            JSON.stringify({ version: 2, waypoints: [{ ...waypoint(), ownerId }] }),
            JSON.stringify({
                version: 2,
                waypoints: [waypoint(), waypoint('44444444-4444-4444-8444-444444444444', 'home')]
            })
        ]) {
            const files = new MemoryFiles().put('waypoints.json', content);
            const store = new WaypointStore(files, new MemoryLogger());

            expect(store.isAvailable).toBe(false);
            expect(store.add(waypoint())).toBe(false);
            expect(files.text('waypoints.json')).toBe(content);
        }
    });

    it('keeps the v1 source untouched when backup creation fails', () => {
        const original = JSON.stringify({ version: 1, waypoints: [legacyWaypoint()] });
        const files = new MemoryFiles().put('waypoints.json', original);
        vi.spyOn(files, 'writeFile').mockImplementation((path) => {
            if (path === 'waypoints.v1.json') throw new Error('disk full');
        });

        const store = new WaypointStore(files, new MemoryLogger());
        expect(store.isAvailable).toBe(false);
        expect(files.text('waypoints.json')).toBe(original);
        expect(files.text('waypoints.v1.json')).toBeUndefined();
    });

    it('keeps in-memory records unchanged when a v2 write fails', () => {
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

    it('rejects update collisions and keeps UUID identity', () => {
        const files = new MemoryFiles();
        const store = new WaypointStore(files, new MemoryLogger());
        store.add(waypoint());
        store.add(waypoint('44444444-4444-4444-8444-444444444444', 'Mine'));

        expect(store.update('44444444-4444-4444-8444-444444444444', (current) => ({ ...current, name: 'home' }))).toBe(
            false
        );
        expect(store.update(waypointId, (current) => ({ ...current, name: 'Base' }))).toBe(true);
        expect(store.get(waypointId)?.name).toBe('Base');
    });
});
