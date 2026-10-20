import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type PumpkinInstance, startPumpkin } from '@pumpkin-plugins/test-harness';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

const fixtureDir = fileURLToPath(new URL('./fixtures/session/', import.meta.url));
const buildCli = createRequire(import.meta.url).resolve('@pumpkin-plugins/build/dist/cli.js');

let server: PumpkinInstance | undefined;
beforeAll(async () => {
    await promisify(execFile)(process.execPath, [buildCli, '--no-update-notifier'], { cwd: fixtureDir });
    server = await startPumpkin({
        name: 'pumpkin-pie-session',
        plugins: [inject('pieProviderPath'), path.join(fixtureDir, 'pumpkin-pie-session-fixture.wasm')],
    });
    await server.waitForLog(/PieSessionFixture: (\{|provider verification failed)/, 15_000);
}, 180_000);
afterAll(async () => {
    await server?.stop();
    if (server) expect(server.errors()).toEqual([]);
});

it('resolves a batch and an argument through a registered session expansion', () => {
    const logs = server?.logs();
    expect(logs).toMatch(/"text":"left=server:none"/);
    expect(logs).toMatch(/"text":"right=server:none"/);
    expect(logs).toMatch(/"value":"server:argument-value"/);
    expect(logs).toMatch(/"senderRejected":true/);
});

it('unregisters the session expansion when the session stops', async () => {
    if (!server) throw new Error('Server did not start');
    const stopFrom = server.lines.length;
    server.command('piesession');
    await server.waitForLog(/PieSessionFixture: session stopped/, 10_000, stopFrom);

    const parseFrom = server.lines.length;
    server.command('pie parse AFTER_STOP:%piesession_echo%');
    await server.waitForLog(/AFTER_STOP:%piesession_echo%/, 10_000, parseFrom);
    await server.waitForLog(/unresolved: piesession_echo/, 10_000, parseFrom);
});
