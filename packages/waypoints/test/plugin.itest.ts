import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtPluginPath, type PumpkinInstance, startPumpkin } from '@pumpkin-plugins/test-harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { info } from '../src/info.ts';

const waypointId = '11111111-1111-4111-8111-111111111111';
const seededStore = JSON.stringify({
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
            files: { 'plugins/data/Waypoints/waypoints.json': seededStore }
        });
    });
    afterAll(async () => {
        await server?.stop();
    });

    it('loads on a real server', async () => {
        await server.waitForLog(new RegExp(`Loaded ${info.name}`));
        expect(server.errors()).toEqual([]);
    });

    it('registers administrative commands and reads the persisted waypoint store', async () => {
        const from = server.lines.length;
        server.command('wp admin list');
        await server.waitForLog(/Spawn \[11111111-1111-4111-8111-111111111111\]/, 5000, from);
        const removeFrom = server.lines.length;
        server.command(`wp admin remove ${waypointId}`);
        await server.waitForLog(/Removed waypoint\./, 5000, removeFrom);

        const saved = JSON.parse(readFileSync(join(server.pluginDataDir(info.name), 'waypoints.json'), 'utf8')) as {
            waypoints: unknown[];
        };
        expect(saved.waypoints).toEqual([]);
        expect(server.errors()).toEqual([]);
    });
});
