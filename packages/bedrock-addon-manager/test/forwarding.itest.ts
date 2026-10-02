import * as path from 'node:path';
import { routerConfig, startFakeRouter } from '@pumpkin-plugins/port-mapping/testing/router';
import { builtPluginPath, freePort, type PumpkinInstance, startPumpkin } from '@pumpkin-plugins/test-harness';
import { afterEach, describe, expect, it } from 'vitest';
import { makeMcpack } from './fixtures.ts';

const upnpumpkin = path.resolve(import.meta.dirname, '../../upnpumpkin');

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

describe('port forwarding through UPnPumpkin', () => {
    it('asks UPnPumpkin over IPC, announces the address the router gave, and closes the port on stop', async () => {
        const router = await startFakeRouter({ natPmp: false });
        cleanup.push(() => router.close());
        const port = await freePort();

        const server: PumpkinInstance = await startPumpkin({
            name: 'forwarding',
            plugins: [builtPluginPath(process.cwd()), builtPluginPath(upnpumpkin)],
            files: {
                'plugins/data/BedrockAddonManager/config.toml': `[web]\nport = ${port}\n`,
                'plugins/data/BedrockAddonManager/packs/a.mcpack': makeMcpack(),
                'plugins/data/UPnPumpkin/config.toml': routerConfig(
                    router,
                    '\n[java]\nenabled = false\n\n[bedrock]\nenabled = false\n'
                )
            }
        });
        cleanup.push(() => server.stop());

        await server.waitForLog(
            new RegExp(
                `Opened port ${port} on the router \\(upnp\\): clients download packs from http://93\\.184\\.216\\.34:${port}\\.`
            ),
            60_000
        );
        expect(router.igd.mappings.get(`tcp:${port}`)).toMatchObject({
            internalPort: port,
            description: 'Bedrock resource packs'
        });

        const from = server.lines.length;
        server.command('baddon list');
        await server.waitForLog(new RegExp(`http://93\\.184\\.216\\.34:${port}/packs/a\\.mcpack`), 10_000, from);
        expect(server.errors()).toEqual([]);

        await server.stop();
        expect([...router.igd.mappings.keys()]).toEqual([]);
    });
});
