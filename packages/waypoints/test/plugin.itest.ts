import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtPluginPath, type PumpkinInstance, startPumpkin } from '@pumpkin-plugins/test-harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { info } from '../src/info.ts';

const waypointId = '11111111-1111-4111-8111-111111111111';
// The reload test logs this error on purpose; other tests ignore it so the order of tests doesn't matter.
const duplicateError = 'duplicate waypoint UUID aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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
            locatorBar: {
                enabled: false,
                color: '#2468AC',
                javaStyleId: 'minecraft:default',
                bedrockTexture: 'waypoints/spawn',
            },
        },
    ],
});

describe(info.name, () => {
    let server: PumpkinInstance;

    beforeAll(async () => {
        server = await startPumpkin({
            name: 'waypoints',
            plugins: [builtPluginPath(process.cwd())],
            files: { 'plugins/data/Waypoints/waypoints.json': legacyStore },
        });
    });
    afterAll(async () => {
        await server?.stop();
    });
    const unexpectedErrors = () => server.errors().filter((line) => !line.includes(duplicateError));

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
                    color: '#2468AC',
                    enabled: true,
                    access: { mode: 'public', grants: [] },
                },
            ],
        });
        expect(unexpectedErrors()).toEqual([]);
    });

    it('registers double coordinate commands and keeps creation player-only', async () => {
        const from = server.lines.length;
        server.command('wp create "Console Test" 12.375 64.5 -8.25');
        await server.waitForLog(/This command can only be used by a player\./, 5000, from);

        const usageFrom = server.lines.length;
        server.command('wp create');
        await server.waitForLog(/Usage: \/wp create <name> \[<x> <y> <z>\]\./, 5000, usageFrom);
        expect(unexpectedErrors()).toEqual([]);
    });

    it('lets the console administer an existing waypoint', async () => {
        await server.waitForLog(new RegExp(`Loaded ${info.name}`));
        const run = async (command: string, reply: RegExp) => {
            const from = server.lines.length;
            server.command(command);
            await server.waitForLog(reply, 5000, from);
        };

        await run('wp set label Spawn Town square', /Updated label for Spawn\./);
        await run('wp disable Spawn', /Disabled waypoint Spawn\./);
        await run('wp get Spawn', /Label: Town square;/);
        const stored = JSON.parse(readFileSync(join(server.pluginDataDir(info.name), 'waypoints.json'), 'utf8'));
        expect(stored.waypoints[0]).toMatchObject({ name: 'Spawn', label: 'Town square', enabled: false });

        await run('wp enable Spawn', /Enabled waypoint Spawn\./);
        await run('wp reset label Spawn', /Reset label for Spawn\./);
        expect(unexpectedErrors()).toEqual([]);
    });

    it('reloads an externally edited waypoint file through /wp reload', async () => {
        await server.waitForLog(new RegExp(`Loaded ${info.name}`));
        const directory = server.pluginDataDir(info.name);
        const original = readFileSync(join(directory, 'waypoints.json'), 'utf8');
        const errorsBefore = server.errors().length;
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
                        access: { mode: 'public', grants: [] },
                    },
                ],
            }),
        );

        const reloadFrom = server.lines.length;
        server.command('wp reload');
        await server.waitForLog(/Reloaded waypoints from disk\./, 5000, reloadFrom);
        expect(server.errors().slice(errorsBefore)).toEqual([]);

        const loaded = readFileSync(join(directory, 'waypoints.json'), 'utf8');
        const record = JSON.parse(loaded).waypoints[0];
        const duplicate = JSON.stringify({
            version: 2,
            waypoints: [record, { ...record, id: record.id.toLowerCase(), name: 'Duplicate' }],
        });
        writeFileSync(join(directory, 'waypoints.json'), duplicate);
        const invalidFrom = server.lines.length;
        server.command('wp reload');
        await server.waitForLog(/Could not reload waypoint data; current data remains active\./, 5000, invalidFrom);
        expect(readFileSync(join(directory, 'waypoints.json'), 'utf8')).toBe(duplicate);
        expect(readFileSync(join(directory, 'waypoints.v1.json'), 'utf8')).toBe(legacyStore);
        const reloadErrors = server.errors().slice(errorsBefore);
        expect(reloadErrors).toHaveLength(1);
        expect(reloadErrors[0]).toContain(duplicateError);
        writeFileSync(join(directory, 'waypoints.json'), original);
        const restoredFrom = server.lines.length;
        server.command('wp reload');
        await server.waitForLog(/Reloaded waypoints from disk\./, 5000, restoredFrom);
    });
});
