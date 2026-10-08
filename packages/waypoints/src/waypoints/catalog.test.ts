import { MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it, vi } from 'vitest';
import { WaypointCatalog } from './catalog.ts';
import { WaypointStore } from './store.ts';

const id = '11111111-1111-4111-8111-111111111111';

function setup() {
    const files = new MemoryFiles();
    const catalog = new WaypointCatalog(new WaypointStore(files, new MemoryLogger()));
    return { files, catalog };
}

describe(WaypointCatalog.name, () => {
    it('creates, resolves, and renames by normalized public name while keeping UUID identity', () => {
        const { catalog } = setup();
        expect(
            catalog.create({
                id,
                name: '  Spawn  ',
                dimension: 'world',
                position: { x: 1.5, y: 64.25, z: -2.75 }
            }).status
        ).toBe('created');

        expect(catalog.getByName('spawn')?.id).toBe(id);
        expect(catalog.rename('Spawn', 'Main Base').status).toBe('updated');
        expect(catalog.getByName('spawn')).toBeUndefined();
        expect(catalog.getByName('main base')).toMatchObject({
            id,
            name: 'Main Base',
            position: { x: 1.5, y: 64.25, z: -2.75 }
        });
    });

    it('rejects normalized collisions without changing the existing catalog', () => {
        const { catalog } = setup();
        catalog.create({ id, name: 'Café', dimension: 'world', position: { x: 0, y: 0, z: 0 } });

        expect(
            catalog.create({
                id: '22222222-2222-4222-8222-222222222222',
                name: 'cafe\u0301',
                dimension: 'world',
                position: { x: 10, y: 0, z: 0 }
            }).status
        ).toBe('conflict');
        expect(catalog.list().map(({ name }) => name)).toEqual(['Café']);
    });

    it('relocates exactly, updates metadata, and enables or disables idempotently', () => {
        const { catalog, files } = setup();
        catalog.create({ id, name: 'Portal', dimension: 'world', position: { x: 1, y: 2, z: 3 } });
        expect(catalog.relocate('Portal', 'world_nether', { x: -0.25, y: 32.5, z: 2.75 }).status).toBe('updated');
        expect(
            catalog.update('Portal', {
                color: 'aabbcc',
                label: 'South Gate',
                description: 'Use the lower path',
                visibilityRange: 80,
                icon: 'minecraft:lodestone'
            }).status
        ).toBe('updated');

        expect(catalog.setEnabled('Portal', false).status).toBe('updated');
        const unchanged = files.text('waypoints.json');
        expect(catalog.setEnabled('Portal', false).status).toBe('updated');
        expect(files.text('waypoints.json')).toBe(unchanged);
        expect(catalog.getByName('portal')).toMatchObject({
            dimension: 'world_nether',
            position: { x: -0.25, y: 32.5, z: 2.75 },
            color: '#AABBCC',
            label: 'South Gate',
            visibilityRange: 80,
            enabled: false
        });
    });

    it('deletes by name and reports missing and invalid mutations distinctly', () => {
        const { catalog } = setup();
        expect(catalog.rename('missing', 'Other').status).toBe('not-found');
        expect(catalog.create({ id, name: '   ', dimension: 'world', position: { x: 0, y: 0, z: 0 } }).status).toBe(
            'invalid'
        );
        catalog.create({ id, name: 'Home', dimension: 'world', position: { x: 0, y: 0, z: 0 } });
        expect(catalog.remove('HOME').status).toBe('removed');
        expect(catalog.list()).toEqual([]);
    });

    it('does not report a saved mutation when persistence fails', () => {
        const { catalog, files } = setup();
        vi.spyOn(files, 'writeFile').mockImplementation(() => {
            throw new Error('disk full');
        });
        expect(catalog.create({ id, name: 'Home', dimension: 'world', position: { x: 0, y: 0, z: 0 } }).status).toBe(
            'unavailable'
        );
        expect(catalog.list()).toEqual([]);
    });
});
