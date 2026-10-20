import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { type PumpkinInstance, startPumpkin } from '@pumpkin-plugins/test-harness';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { PIE_RELEASE, resolvePieProvider } from './provider.ts';

let server: PumpkinInstance | undefined;
beforeAll(async () => {
    server = await startPumpkin({ name: 'pumpkin-pie-provider', plugins: [inject('pieProviderPath')] });
    await server.waitForLog(/Loaded.*PumpkinPIE/);
});
afterAll(async () => {
    await server?.stop();
});

it('uses the pinned release bytes and reuses the verified cache without network access', async () => {
    const file = inject('pieProviderPath');
    expect(
        createHash('sha256')
            .update(await fs.readFile(file))
            .digest('hex'),
    ).toBe(PIE_RELEASE.sha256);
    expect(
        await resolvePieProvider({
            fetch: async () => {
                throw new Error('cache must not download');
            },
        }),
    ).toBe(file);
    expect(server?.errors()).toEqual([]);
});
it('caches the provider in the repository cache folder', () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    expect(path.dirname(inject('pieProviderPath'))).toBe(path.join(repoRoot, '.cache', 'pumpkin-pie'));
});
it('resolves a built-in and preserves unknown tokens in the real provider', async () => {
    if (!server) throw new Error('Provider server did not start');
    const from = server.lines.length;
    server.command('pie parse PIE_FIXTURE:%server_online%:%missing_value%');
    await server.waitForLog(/PIE_FIXTURE:0:%missing_value%/, 10000, from);
    await server.waitForLog(/unresolved: missing_value/, 10000, from);
    expect(server.errors()).toEqual([]);
});
