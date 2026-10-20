import { builtPluginPath, type PumpkinInstance, startPumpkin } from '@pumpkin-plugins/test-harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { info } from '../src/info.ts';

// The harness cannot connect a Minecraft client, so no player is online here. The tick handler runs
// against the real server's world and player lists, but the payloads AppleSkin receives are checked
// only by the unit tests against fake players.
describe(info.name, () => {
    let server: PumpkinInstance;

    beforeAll(async () => {
        server = await startPumpkin({
            name: 'apple-skin-pumpkin',
            plugins: [builtPluginPath(process.cwd())],
            logLevel: 'debug',
        });
    });
    afterAll(async () => {
        await server?.stop();
    });

    it('loads and handles server ticks without runtime errors', async () => {
        await server.waitForLog(new RegExp(`Loaded ${info.name}`));
        await server.waitForLog(new RegExp(`${info.name} Finished the first tick, syncing hunger on every tick`));
        expect(server.errors()).toEqual([]);
    });
});
