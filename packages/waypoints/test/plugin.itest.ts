import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtPluginPath, type PumpkinInstance, startPumpkin } from '@pumpkin-plugins/test-harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { info } from '../src/info.ts';

const waypointId = '11111111-1111-4111-8111-111111111111';
const legacyStore = JSON.stringify({
    version: 1,
    waypoints: [
        {
            id: waypointId,
            name: 'Spawn',
            dimension: 'world',
            x: 0,
            y: 64,
            z: 0,
            ownerId: '22222222-2222-4222-8222-222222222222',
            visibility: 'public',
            allowedPlayerIds: [],
            locatorBar: { enabled: false }
        }
    ]
});

describe(info.name, () => {
    let server: PumpkinInstance;

    beforeAll(async () => {
        server = await startPumpkin({
            name: 'waypoints',
            plugins: [builtPluginPath(process.cwd())],
            files: { 'plugins/data/Waypoints/waypoints.json': legacyStore }
        });
    });
    afterAll(async () => {
        await server?.stop();
    });

    it('loads on the pinned real server and migrates v1 with a byte-identical backup', async () => {
        await server.waitForLog(new RegExp(`Loaded ${info.name}`));
        const directory = server.pluginDataDir(info.name);
        expect(readFileSync(join(directory, 'waypoints.v1.json'), 'utf8')).toBe(legacyStore);
        expect(JSON.parse(readFileSync(join(directory, 'waypoints.json'), 'utf8'))).toEqual({
            version: 2,
            waypoints: [
                {
                    id: waypointId,
                    name: 'Spawn',
                    dimension: 'world',
                    position: { x: 0, y: 64, z: 0 },
                    color: '#FFFFFF',
                    enabled: true,
                    access: { mode: 'public', grants: [] }
                }
            ]
        });
        expect(server.errors()).toEqual([]);
    });

    it('registers double coordinate commands and rejects console administration cleanly', async () => {
        const from = server.lines.length;
        server.command('wp create "Console Test" 12.375 64.5 -8.25');
        await server.waitForLog(/This command can only be used by a player\./, 5000, from);

        const usageFrom = server.lines.length;
        server.command('wp create');
        await server.waitForLog(/Usage: \/wp create <name> \[<x> <y> <z>\]\./, 5000, usageFrom);
        expect(server.errors()).toEqual([]);
    });

    it('reloads an externally edited waypoint file through /wp reload', async () => {
        await server.waitForLog(new RegExp(`Loaded ${info.name}`));
        const directory = server.pluginDataDir(info.name);
        writeFileSync(
            join(directory, 'waypoints.json'),
            JSON.stringify({
                version: 2,
                waypoints: [
                    {
                        id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
                        name: 'Reloaded',
                        dimension: 'world',
                        position: { x: 1, y: 64, z: 2 },
                        color: '#FFFFFF',
                        enabled: true,
                        access: { mode: 'public', grants: [] }
                    }
                ]
            })
        );

        const reloadFrom = server.lines.length;
        server.command('wp reload');
        await server.waitForLog(/Reloaded waypoints from disk\./, 5000, reloadFrom);
        expect(server.errors()).toEqual([]);

        const loaded = readFileSync(join(directory, 'waypoints.json'), 'utf8');
        const record = JSON.parse(loaded).waypoints[0];
        const duplicate = JSON.stringify({
            version: 2,
            waypoints: [record, { ...record, id: record.id.toLowerCase(), name: 'Duplicate' }]
        });
        writeFileSync(join(directory, 'waypoints.json'), duplicate);
        const invalidFrom = server.lines.length;
        server.command('wp reload');
        await server.waitForLog(/Could not reload waypoint data; current data remains active\./, 5000, invalidFrom);
        expect(readFileSync(join(directory, 'waypoints.json'), 'utf8')).toBe(duplicate);
        expect(readFileSync(join(directory, 'waypoints.v1.json'), 'utf8')).toBe(legacyStore);
        expect(server.errors()).toHaveLength(1);
        expect(server.errors()[0]).toContain('duplicate waypoint UUID aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
        writeFileSync(join(directory, 'waypoints.json'), loaded);
        const restoredFrom = server.lines.length;
        server.command('wp reload');
        await server.waitForLog(/Reloaded waypoints from disk\./, 5000, restoredFrom);
    });
});
