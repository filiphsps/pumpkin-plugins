import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { builtPluginPath, type PumpkinInstance, startPumpkin } from '@pumpkin-plugins/test-harness';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PIE_RELEASE, resolvePieProvider } from '../../../tools/apis/pumpkin-pie-api/test/provider.ts';
import { run as buildPlugin } from '../../../tools/build/src/cli.ts';
import { info } from '../src/info.ts';

describe('Distant Horizons PumpkinPIE integration', () => {
    let unavailableServer: PumpkinInstance | undefined;
    let providerServer: PumpkinInstance | undefined;
    let providerPath: string;

    beforeAll(async () => {
        const fixtureDir = join(process.cwd(), 'test/fixtures/pie-consumer');
        await buildPlugin([], fixtureDir);
        providerPath = await resolvePieProvider();

        unavailableServer = await startPumpkin({
            name: 'dhs-pie-optional',
            plugins: [builtPluginPath(process.cwd())],
        });
        await unavailableServer.waitForLog(new RegExp(`Loaded ${info.name}`));
        await vi.waitFor(
            async () => {
                const from = unavailableServer?.lines.length ?? 0;
                unavailableServer?.command('dhs status');
                const status = await unavailableServer?.waitForLog(/worker tick\(s\)/, 1000, from);
                expect(status).toMatch(/[1-9][0-9]* worker tick\(s\)/);
            },
            { timeout: 5000, interval: 100 },
        );
        expect(unavailableServer.errors()).toEqual([]);
        await unavailableServer.stop();

        providerServer = await startPumpkin({
            name: 'dhs-pie-provider',
            plugins: [providerPath, builtPluginPath(process.cwd()), join(fixtureDir, 'dhs-pie-consumer-fixture.wasm')],
        });
        await providerServer.waitForLog(/Loaded.*PumpkinPIE/, 15_000);
        await providerServer.waitForLog(new RegExp(`Loaded ${info.name}`));
        await providerServer.waitForLog(/DistantHorizonsPIEFixture:.*"advertisedCount":15/, 15_000);
    }, 180_000);

    afterAll(async () => {
        await providerServer?.stop();
        await unavailableServer?.stop();
        if (providerServer) expect(providerServer.errors()).toEqual([]);
        if (unavailableServer) expect(unavailableServer.errors()).toEqual([]);
    });

    it('keeps PumpkinPIE optional while DH server ticks continue', () => {
        expect(unavailableServer?.logs()).toMatch(/worker tick\(s\)/);
        expect(unavailableServer?.errors()).toEqual([]);
    });

    it('registers the exact expansion and resolves live global, cache, and viewer values', async () => {
        const digest = createHash('sha256')
            .update(await readFile(providerPath))
            .digest('hex');
        expect(digest).toBe(PIE_RELEASE.sha256);
        expect(providerServer?.logs()).toMatch(/"advertisedCount":15/);
        expect(providerServer?.logs()).toMatch(/"clients":\{"known":true,"value":"0"\}/);
        expect(providerServer?.logs()).toMatch(/"memoryEntries":\{"known":true,"value":"0"\}/);
        expect(providerServer?.logs()).toMatch(/"clientConnected":\{"known":false\}/);
    });
});
