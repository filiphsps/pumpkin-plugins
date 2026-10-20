import { builtPluginPath, type PumpkinInstance, startPumpkin } from '@pumpkin-plugins/test-harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { info } from '../src/info.ts';

// The harness cannot connect a Minecraft client, so no player is online here. The light block
// changes sent with real `minecraft:light` state ids, and the event payloads the plugin reads, are
// checked only by the unit tests against hand-built fakes.
describe(info.name, () => {
    let server: PumpkinInstance;

    beforeAll(async () => {
        server = await startPumpkin({ name: 'dynamic-lights-pumpkin', plugins: [builtPluginPath(process.cwd())] });
    });
    afterAll(async () => {
        await server?.stop();
    });

    it('loads on a real server', async () => {
        await server.waitForLog(new RegExp(`Loaded ${info.name}`));
        expect(server.errors()).toEqual([]);
    });

    it('routes its command handler without stopping the plugin store', async () => {
        const from = server.lines.length;

        server.command('dynamiclights');

        await server.waitForLog(/This command can only be used by a player\./, 10_000, from);
        expect(server.errors()).toEqual([]);
    });
});
