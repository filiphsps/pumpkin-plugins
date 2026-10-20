import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type PumpkinInstance, startPumpkin } from '@pumpkin-plugins/test-harness';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

const fixtureDir = fileURLToPath(new URL('./fixtures/consumer/', import.meta.url));
const buildCli = createRequire(import.meta.url).resolve('@pumpkin-plugins/build/dist/cli.js');

let server: PumpkinInstance | undefined;
beforeAll(async () => {
    await promisify(execFile)(process.execPath, [buildCli, '--no-update-notifier'], { cwd: fixtureDir });
    server = await startPumpkin({
        name: 'pumpkin-pie-consumer',
        plugins: [inject('pieProviderPath'), path.join(fixtureDir, 'pumpkin-pie-consumer-fixture.wasm')],
    });
    await server.waitForLog(/PieConsumerFixture: (\{|provider verification failed)/, 15_000);
}, 180_000);
afterAll(async () => {
    await server?.stop();
});

it('pings, resolves built-in and own placeholders and answers callbacks over real guest IPC', () => {
    const line = server?.lines.find((entry) => entry.includes('PieConsumerFixture: {'));
    expect(line, server?.logs()).toBeDefined();
    const result = JSON.parse(line?.slice(line.indexOf('{')) ?? '{}');
    expect(result.protocol).toBe(0);
    expect(result.registered.namespace).toBe('pieconsumer');
    expect(result.online).toEqual({ text: 'online=0', unresolved: [] });
    expect(result.own).toEqual({ text: 'own=server:none', unresolved: [] });
    expect(result.argument).toEqual({ known: true, value: 'server:arg' });
    expect(server?.errors()).toEqual([]);
});
