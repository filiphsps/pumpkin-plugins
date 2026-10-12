import { builtPluginPath, type PumpkinInstance, startPumpkin } from '@pumpkin-plugins/test-harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { info } from '../src/info.ts';

describe(info.name, () => {
    let server: PumpkinInstance;

    beforeAll(async () => {
        server = await startPumpkin({ name: 'apple-skin-pumpkin', plugins: [builtPluginPath(process.cwd())] });
    });
    afterAll(async () => {
        await server?.stop();
    });

    it('loads and handles server ticks without runtime errors', async () => {
        await server.waitForLog(new RegExp(`Loaded ${info.name}`));
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(server.errors()).toEqual([]);
    });
});
