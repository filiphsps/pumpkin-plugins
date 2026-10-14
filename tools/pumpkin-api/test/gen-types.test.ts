import * as path from 'node:path';
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    ensurePumpkinWit: vi.fn(() => '/cached/wit'),
    execFileSync: vi.fn(),
}));

vi.mock('../src/wit.mjs', () => ({ ensurePumpkinWit: mocks.ensurePumpkinWit }));
vi.mock('node:child_process', () => ({ execFileSync: mocks.execFileSync }));

const apiRoot = path.resolve(import.meta.dirname, '..');

it('uses the repository cache by default when generating API types', async () => {
    const previousCacheOverride = process.env.PUMPKIN_PLUGINS_CACHE_DIR;
    delete process.env.PUMPKIN_PLUGINS_CACHE_DIR;

    try {
        const { generateTypes } = await import(new URL('../scripts/gen-types.mjs', import.meta.url).href);
        generateTypes(['node', 'gen-types.mjs']);

        expect(mocks.ensurePumpkinWit).toHaveBeenCalledWith({
            lockFile: path.join(apiRoot, 'wit.lock.json'),
            cacheRoot: path.resolve(apiRoot, '../..', '.cache'),
        });
    } finally {
        if (previousCacheOverride === undefined) delete process.env.PUMPKIN_PLUGINS_CACHE_DIR;
        else process.env.PUMPKIN_PLUGINS_CACHE_DIR = previousCacheOverride;
    }
});
