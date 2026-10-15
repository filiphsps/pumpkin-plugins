import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { builtPluginPath, type PumpkinInstance, startPumpkin } from '@pumpkin-plugins/test-harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PIE_RELEASE, resolvePieProvider } from '../../../tools/apis/pumpkin-pie-api/test/provider.ts';
import { run as buildPlugin } from '../../../tools/build/src/cli.ts';

describe('Waypoints PumpkinPIE integration', () => {
    let unavailableServer: PumpkinInstance | undefined;
    let server: PumpkinInstance | undefined;
    let providerPath: string;

    beforeAll(async () => {
        const fixtureDir = join(process.cwd(), 'test/fixtures/pie-consumer');
        await buildPlugin([], fixtureDir);
        providerPath = await resolvePieProvider();

        unavailableServer = await startPumpkin({
            name: 'waypoints-pie-optional',
            plugins: [builtPluginPath(process.cwd())],
        });
        await unavailableServer.waitForLog(/Loaded Waypoints/);
        const reloadFrom = unavailableServer.lines.length;
        unavailableServer.command('wp reload');
        await unavailableServer.waitForLog(/Reloaded waypoints from disk\./, 5000, reloadFrom);
        await unavailableServer.stop();

        server = await startPumpkin({
            name: 'waypoints-pie-provider',
            plugins: [
                providerPath,
                builtPluginPath(process.cwd()),
                join(fixtureDir, 'waypoints-pie-consumer-fixture.wasm'),
            ],
        });
        await server.waitForLog(/Loaded.*PumpkinPIE/, 15_000);
        await server.waitForLog(/Loaded Waypoints/);
        await server.waitForLog(/WaypointsPIEFixture:.*"advertisedCount":69.*"offlineKnown":false/, 15_000);
    }, 180_000);

    afterAll(async () => {
        await server?.stop();
        if (server) expect(server.errors()).toEqual([]);
        if (unavailableServer) expect(unavailableServer.errors()).toEqual([]);
    });

    it('registers every advertised identifier and dispatches real provider callbacks', async () => {
        const digest = createHash('sha256')
            .update(await readFile(providerPath))
            .digest('hex');
        expect(digest).toBe(PIE_RELEASE.sha256);
        expect(PIE_RELEASE.sourceCommit).toBe('b7cbb14417b397bca71a36b62efa8caa1ba72354');
        expect(PIE_RELEASE.pumpkinRelease).toBe('0.2.0+26.3-26.51');
        expect(PIE_RELEASE.apiArtifact).toBe('v0.1.1');
        expect(server?.logs()).toMatch(/WaypointsPIEFixture:.*"advertisedCount":69/);
        expect(server?.logs()).toMatch(/"text":"Resolved literal text","unresolved":\[\]/);
        expect(server?.logs()).toMatch(/"text":"Count: %waypoints_count%","unresolved":\["waypoints_count"\]/);
        expect(server?.logs()).toMatch(/"offlineKnown":false/);
        expect(unavailableServer?.logs()).toMatch(/Reloaded waypoints from disk\./);
    });
});
