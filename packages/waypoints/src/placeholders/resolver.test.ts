import { MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it } from 'vitest';
import { WaypointCatalog } from '../waypoints/catalog.ts';
import { WaypointStore } from '../waypoints/store.ts';
import { waypointPlaceholderDefinitions } from './definitions.ts';
import type { WaypointQueryViewer } from './queries.ts';
import { parsePlaceholder, resolvePlaceholder, type WaypointCatalogReader } from './resolver.ts';

const viewerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ids = {
    accessible: '11111111-1111-4111-8111-111111111111',
    denied: '22222222-2222-4222-8222-222222222222',
    disabled: '33333333-3333-4333-8333-333333333333',
    missing: '44444444-4444-4444-8444-444444444444',
};

function setup() {
    const catalog = new WaypointCatalog(new WaypointStore(new MemoryFiles(), new MemoryLogger()));
    const viewer: WaypointQueryViewer = {
        dimension: 'world',
        isOperator: false,
        playerId: viewerId,
        position: { x: 0, y: 64, z: 0 },
        yaw: 0,
        hasPermission: (node) => node === 'Waypoints:group.builders',
    };
    catalog.create({
        id: ids.accessible,
        name: 'Home',
        dimension: 'world',
        position: { x: 0, y: 64, z: -20 },
        label: 'Main home',
        access: { mode: 'restricted', grants: [{ type: 'player', playerId: viewerId }] },
    });
    catalog.create({
        id: ids.denied,
        name: 'Private',
        dimension: 'world_nether',
        position: { x: 5, y: 80, z: 6 },
        access: { mode: 'restricted', grants: [{ type: 'player', playerId: ids.denied }] },
    });
    catalog.create({
        id: ids.disabled,
        name: 'Disabled',
        dimension: 'world',
        position: { x: 1, y: 64, z: 1 },
        enabled: false,
        access: { mode: 'public', grants: [] },
    });
    return { catalog, viewer };
}

describe('waypoint placeholder parser', () => {
    it('parses catalog and no-argument destination fields', () => {
        expect(parsePlaceholder('count')).toEqual({ kind: 'catalog', name: 'count' });
        expect(parsePlaceholder('closest_name')).toEqual({ kind: 'closest', field: 'name' });
        expect(parsePlaceholder('closest_exists')).toEqual({ kind: 'closest', field: 'exists' });
    });

    it('accepts decimal ranks from 1 through 100 and rejects malformed ranks', () => {
        expect(parsePlaceholder('nearest_name', '1')).toEqual({ kind: 'nearest', field: 'name', rank: 1 });
        expect(parsePlaceholder('nearest_exists', '0100')).toEqual({ kind: 'nearest', field: 'exists', rank: 100 });
        for (const rank of [undefined, '', '0', '101', '-1', '+1', '1.0', '1e0', '0x1', 'Infinity', 'NaN']) {
            expect(parsePlaceholder('nearest_name', rank)).toBeUndefined();
        }
    });

    it('accepts bounded plain decimal radii and rejects exponent, hex, and nonfinite spellings', () => {
        expect(parsePlaceholder('nearby_count', '.5')).toEqual({ kind: 'catalog', name: 'nearby_count', radius: 0.5 });
        expect(parsePlaceholder('nearby_count', '30000000')).toEqual({
            kind: 'catalog',
            name: 'nearby_count',
            radius: 30_000_000,
        });
        for (const radius of [undefined, '', '0', '-1', '+1', '30000000.1', '1e2', '0x10', 'Infinity', 'NaN']) {
            expect(parsePlaceholder('nearby_count', radius)).toBeUndefined();
        }
    });

    it('preserves exact bounded world arguments and normalizes canonical UUID arguments', () => {
        const world = 'é'.repeat(64);
        expect(parsePlaceholder('count_world', world)).toEqual({ kind: 'catalog', name: 'count_world', world });
        expect(parsePlaceholder('count_world', 'é'.repeat(65))).toBeUndefined();
        expect(parsePlaceholder('count_world', '')).toBeUndefined();
        expect(parsePlaceholder('waypoint_name', ids.accessible.toUpperCase())).toEqual({
            kind: 'waypoint',
            field: 'name',
            id: ids.accessible,
        });
        expect(parsePlaceholder('waypoint_exists', 'not-a-uuid')).toBeUndefined();
    });

    it('rejects arguments on no-argument names, unknown names, and unadvertised fields', () => {
        expect(parsePlaceholder('count', '')).toBeUndefined();
        expect(parsePlaceholder('closest_name', '1')).toBeUndefined();
        expect(parsePlaceholder('waypoint_owner', ids.accessible)).toBeUndefined();
        expect(parsePlaceholder('unknown')).toBeUndefined();
    });

    it('accepts the documented argument form for every advertised identifier', () => {
        for (const definition of waypointPlaceholderDefinitions) {
            const argument =
                definition.argument === 'rank'
                    ? '1'
                    : definition.argument === 'radius'
                      ? '1'
                      : definition.argument === 'uuid'
                        ? ids.accessible
                        : definition.argument === 'world'
                          ? 'world'
                          : undefined;
            expect(parsePlaceholder(definition.name, argument), definition.name).toBeDefined();
        }
    });
});

describe('waypoint placeholder resolver', () => {
    it('requires a live viewer before returning even public catalog values', () => {
        const { catalog } = setup();

        expect(resolvePlaceholder('count', undefined, catalog, undefined)).toBeUndefined();
    });

    it('resolves accessible catalog and closest values from the current catalog snapshot', () => {
        const { catalog, viewer } = setup();

        expect(resolvePlaceholder('count', undefined, catalog, viewer)).toBe('1');
        expect(resolvePlaceholder('closest_exists', undefined, catalog, viewer)).toBe('true');
        expect(resolvePlaceholder('closest_name', undefined, catalog, viewer)).toBe('Home');
        expect(resolvePlaceholder('nearest_name', '2', catalog, viewer)).toBe('');
        expect(resolvePlaceholder('closest_id', undefined, catalog, viewer)).toBe(ids.accessible);

        catalog.rename('Home', 'New home');
        catalog.update('New home', { label: 'Updated' });
        expect(resolvePlaceholder('closest_name', undefined, catalog, viewer)).toBe('New home');
        expect(resolvePlaceholder('closest_label', undefined, catalog, viewer)).toBe('Updated');
    });

    it('returns false for unknown, disabled, and denied UUID existence with the same observable result', () => {
        const { catalog, viewer } = setup();

        for (const id of [ids.denied, ids.disabled, ids.missing]) {
            expect(resolvePlaceholder('waypoint_exists', id, catalog, viewer)).toBe('false');
            expect(resolvePlaceholder('waypoint_name', id, catalog, viewer)).toBeUndefined();
        }
    });

    it('allows authorized metadata across worlds while declining cross-world geometry', () => {
        const { catalog, viewer } = setup();
        catalog.update('Private', {
            access: { mode: 'restricted', grants: [{ type: 'group', slug: 'builders' }] },
        });

        expect(resolvePlaceholder('waypoint_name', ids.denied, catalog, viewer)).toBe('Private');
        expect(resolvePlaceholder('waypoint_world', ids.denied, catalog, viewer)).toBe('world_nether');
        expect(resolvePlaceholder('waypoint_distance', ids.denied, catalog, viewer)).toBeUndefined();
        expect(resolvePlaceholder('waypoint_direction', ids.denied, catalog, viewer)).toBeUndefined();
    });

    it('declines oversized UTF-8 values and reports only bounded failure details', () => {
        const { catalog, viewer } = setup();
        catalog.update('Home', { description: 'é'.repeat(16_385) });
        const failures: [string, string][] = [];

        expect(
            resolvePlaceholder('closest_description', undefined, catalog, viewer, (name, reason) => {
                failures.push([name, reason]);
            }),
        ).toBeUndefined();
        expect(failures).toEqual([['closest_description', 'value_too_large']]);
    });

    it('declines all catalog values after a read failure instead of reporting zero', () => {
        const { viewer } = setup();
        const failures: [string, string][] = [];
        const brokenCatalog: WaypointCatalogReader = {
            get isAvailable() {
                return true;
            },
            getById() {
                throw new Error('sensitive waypoint text');
            },
            list() {
                throw new Error('sensitive waypoint text');
            },
        };

        expect(
            resolvePlaceholder('count', undefined, brokenCatalog, viewer, (name, reason) => {
                failures.push([name, reason]);
            }),
        ).toBeUndefined();
        expect(failures).toEqual([['count', 'query_failed']]);
    });

    it('reports unavailable storage without reading it or returning a false zero', () => {
        const { viewer } = setup();
        const failures: [string, string][] = [];
        const unavailableCatalog: WaypointCatalogReader = {
            isAvailable: false,
            getById() {
                throw new Error('unavailable storage must not be read');
            },
            list() {
                throw new Error('unavailable storage must not be read');
            },
        };

        expect(
            resolvePlaceholder('count', undefined, unavailableCatalog, viewer, (name, reason) => {
                failures.push([name, reason]);
            }),
        ).toBeUndefined();
        expect(failures).toEqual([['count', 'query_failed']]);
    });
});
