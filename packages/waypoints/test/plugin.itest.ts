import { builtPluginPath, type PumpkinInstance, startPumpkin } from '@pumpkin-plugins/test-harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { info } from '../src/info.ts';

describe(info.name, () => {
    let server: PumpkinInstance;

    beforeAll(async () => {
        server = await startPumpkin({ name: 'waypoints', plugins: [builtPluginPath(process.cwd())] });
    });
    afterAll(async () => {
        await server?.stop();
    });

    it('loads on a real server', async () => {
        await server.waitForLog(new RegExp(`Loaded ${info.name}`));
        expect(server.errors()).toEqual([]);
    });

    it('registers its starter command', async () => {
        const from = server.lines.length;
        server.command('plugin');
        await server.waitForLog(new RegExp(`${info.name} is running\\.`), 5000, from);
        expect(server.errors()).toEqual([]);
    });
});
