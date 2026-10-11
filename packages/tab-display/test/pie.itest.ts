import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { builtPluginPath, type PumpkinInstance, startPumpkin } from '@pumpkin-plugins/test-harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run as buildPlugin } from '../../../tools/build/src/cli.ts';
import { PIE_RELEASE, resolvePieProvider } from '../../../tools/pumpkin-pie-api/test/provider.ts';

describe('TabDisplay PumpkinPIE integration', () => {
    let server: PumpkinInstance;
    let providerPath: string;

    beforeAll(async () => {
        const fixtureDir = join(process.cwd(), 'test/fixtures/pie-expansion');
        await buildPlugin([], fixtureDir);
        providerPath = await resolvePieProvider();
        server = await startPumpkin({
            name: 'tab-display-pie',
            plugins: [
                providerPath,
                builtPluginPath(process.cwd()),
                join(fixtureDir, 'tab-display-pie-expansion-fixture.wasm')
            ]
        });
        await server.waitForLog(/Loaded.*PumpkinPIE/, 15_000);
        await server.waitForLog(/Loaded TabDisplay/);
        await server.waitForLog(/TabDisplayPIEFixture:.*senderRejected/);
    }, 180_000);

    afterAll(async () => {
        await server?.stop();
    });

    it('uses the checksum-pinned provider artifact and verifies a real IPC batch and expansion', async () => {
        const digest = createHash('sha256')
            .update(await readFile(providerPath))
            .digest('hex');
        expect(digest).toBe(PIE_RELEASE.sha256);
        expect(PIE_RELEASE.sourceCommit).toBe('b7cbb14417b397bca71a36b62efa8caa1ba72354');
        expect(PIE_RELEASE.pumpkinRelease).toBe('0.2.0+26.3-26.51');
        expect(PIE_RELEASE.apiArtifact).toBe('v0.1.1');
        expect(server.logs()).toMatch(/"text":"left=server:none"/);
        expect(server.logs()).toMatch(/"text":"right=server:none"/);
        expect(server.logs()).toMatch(/"value":"server:argument-value"/);
        expect(server.logs()).toMatch(/"senderRejected":true/);
        expect(server.errors()).toEqual([]);
    });

    it('negotiates PIE in TabDisplay and unregisters the fixture expansion on stop', async () => {
        await server.waitForLog(/TabDisplay: PumpkinPIE provider is ready/, 10_000);
        const statusFrom = server.lines.length;
        server.command('tabdisplay status');
        await server.waitForLog(/Placeholder provider: ready/, 5_000, statusFrom);

        const stopFrom = server.lines.length;
        server.command('piefixture');
        await server.waitForLog(/TabDisplayPIEFixture: session stopped/, 10_000, stopFrom);

        const parseFrom = server.lines.length;
        server.command('pie parse AFTER_STOP:%tabdisplayfixture_echo%');
        await server.waitForLog(/AFTER_STOP:%tabdisplayfixture_echo%/, 10_000, parseFrom);
        await server.waitForLog(/unresolved: tabdisplayfixture_echo/, 10_000, parseFrom);
        expect(server.errors()).toEqual([]);
    });
});
