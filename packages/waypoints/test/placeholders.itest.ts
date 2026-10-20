import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PIE_RELEASE, resolvePieProvider } from '@pumpkin-plugins/pumpkin-pie-api/testing/provider';
import { builtPluginPath, type PumpkinInstance, startPumpkin } from '@pumpkin-plugins/test-harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { waypointPlaceholderNames } from '../src/placeholders/definitions.ts';

// Build fixtures through the builder's published CLI, as a standalone plugin would.
const buildCli = createRequire(import.meta.url).resolve('@pumpkin-plugins/build/dist/cli.js');
const buildPlugin = (cwd: string) => promisify(execFile)(process.execPath, [buildCli, '--no-update-notifier'], { cwd });

describe('Waypoints PumpkinPIE integration', () => {
    let unavailableServer: PumpkinInstance | undefined;
    let server: PumpkinInstance | undefined;
    let providerPath: string;

    beforeAll(async () => {
        const fixtureDir = join(process.cwd(), 'test/fixtures/pie-consumer');
        await buildPlugin(fixtureDir);
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
        await server.waitForLog(/WaypointsPIEFixture:.*"offlineKnown":false/, 15_000);
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
        expect(server?.logs()).toContain(`"advertisedCount":${waypointPlaceholderNames.length},`);
        expect(server?.logs()).toMatch(/"text":"Resolved literal text","unresolved":\[\]/);
        expect(server?.logs()).toMatch(/"text":"Count: %waypoints_count%","unresolved":\["waypoints_count"\]/);
        expect(server?.logs()).toMatch(/"offlineKnown":false/);
        expect(unavailableServer?.logs()).toMatch(/Reloaded waypoints from disk\./);
    });
});
