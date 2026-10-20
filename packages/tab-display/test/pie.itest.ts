import { resolvePieProvider } from '@pumpkin-plugins/pumpkin-pie-api/testing/provider';
import { builtPluginPath, type PumpkinInstance, startPumpkin } from '@pumpkin-plugins/test-harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('TabDisplay PumpkinPIE integration', () => {
    let server: PumpkinInstance;

    beforeAll(async () => {
        server = await startPumpkin({
            name: 'tab-display-pie',
            plugins: [await resolvePieProvider(), builtPluginPath(process.cwd())],
        });
        await server.waitForLog(/Loaded.*PumpkinPIE/, 15_000);
        await server.waitForLog(/Loaded TabDisplay/);
    }, 180_000);

    afterAll(async () => {
        await server?.stop();
        if (server) expect(server.errors()).toEqual([]);
    });

    it('negotiates PIE in TabDisplay and reports the provider as ready', async () => {
        await server.waitForLog(/TabDisplay: PumpkinPIE provider is ready/, 10_000);
        const statusFrom = server.lines.length;
        server.command('tabdisplay status');
        await server.waitForLog(/Placeholder provider: ready/, 5_000, statusFrom);
        expect(server.errors()).toEqual([]);
    });
});
