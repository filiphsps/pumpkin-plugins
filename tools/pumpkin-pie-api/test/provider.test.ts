import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { PIE_RELEASE, resolvePieProvider } from './provider.ts';

const dirs: string[] = [];
afterEach(async () => {
    await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    dirs.length = 0;
});
async function cache() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-provider-'));
    dirs.push(dir);
    return dir;
}

it('refuses an HTTP failure without leaving a provider artifact behind', async () => {
    const cacheDir = await cache();
    await expect(
        resolvePieProvider({ cacheDir, fetch: async () => new Response('missing', { status: 404 }) })
    ).rejects.toThrow('HTTP 404');
    expect(await fs.readdir(cacheDir)).toEqual([]);
});
it('refuses downloaded bytes that do not match the pinned artifact hash', async () => {
    const cacheDir = await cache();
    const urls: string[] = [];
    await expect(
        resolvePieProvider({
            cacheDir,
            fetch: async (input) => {
                urls.push(String(input));
                return new Response('untrusted wasm');
            }
        })
    ).rejects.toThrow('SHA-256 mismatch');
    expect(urls).toEqual(['https://github.com/Rennex07/PumpkinPIE/releases/download/v0.2.3/pumpkin_pie_plugin.wasm']);
    expect(await fs.readdir(cacheDir)).toEqual([]);
});
it('revalidates cached artifacts and never silently trusts corrupt bytes', async () => {
    const cacheDir = await cache();
    const target = path.join(cacheDir, `${PIE_RELEASE.tag}-${PIE_RELEASE.asset}`);
    await fs.writeFile(target, 'corrupted cache');
    await expect(
        resolvePieProvider({
            cacheDir,
            fetch: async () => {
                throw new Error('must not fetch');
            }
        })
    ).rejects.toThrow('SHA-256 mismatch');
    expect(
        createHash('sha256')
            .update(await fs.readFile(target))
            .digest('hex')
    ).not.toBe(PIE_RELEASE.sha256);
});
