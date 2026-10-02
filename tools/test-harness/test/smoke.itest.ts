import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type PumpkinInstance, startPumpkin } from '../src/index.ts';

describe('harness smoke test', () => {
    let server: PumpkinInstance;

    beforeAll(async () => {
        server = await startPumpkin({ name: 'smoke' });
    });
    afterAll(async () => {
        await server?.stop();
    });

    it('starts a real Pumpkin on the requested ports', async () => {
        expect(server.logs()).toContain(`127.0.0.1:${server.javaPort}`);
        expect(server.errors()).toEqual([]);
    });

    it('accepts console commands', async () => {
        const from = server.lines.length;
        server.command('list');
        await server.waitForLog(/players? online|There are/i, 10_000, from);
    });
});
