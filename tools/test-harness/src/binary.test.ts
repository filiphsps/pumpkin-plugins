import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePumpkinBinary } from './binary.ts';
import { PUMPKIN_RELEASE } from './pumpkin-version.ts';
import { assetName } from './util.ts';

const cacheDirs: string[] = [];

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    for (const dir of cacheDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setupCache(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-binary-'));
    cacheDirs.push(dir);
    vi.stubEnv('PUMPKIN_BIN', undefined);
    vi.stubEnv('PUMPKIN_CACHE_DIR', dir);
    return dir;
}

describe('resolvePumpkinBinary', () => {
    it('downloads a checksum-verified binary once and reuses the cache', async () => {
        const cache = setupCache();
        const asset = assetName(process.platform, process.arch);
        const bytes = Buffer.from('test Pumpkin binary');
        const checksum = createHash('sha256').update(bytes).digest('hex');
        const fetchMock = vi.fn<typeof fetch>(async (input) => {
            if (String(input).endsWith('/checksums.sha256')) return new Response(`${checksum}  ${asset}\n`);
            return new Response(bytes);
        });
        vi.stubGlobal('fetch', fetchMock);

        const expected = path.join(cache, `${PUMPKIN_RELEASE}-${asset}`);
        expect(await resolvePumpkinBinary()).toBe(expected);
        expect(fs.readFileSync(expected)).toEqual(bytes);
        expect(fs.statSync(expected).mode & 0o777).toBe(0o755);

        expect(await resolvePumpkinBinary()).toBe(expected);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('rejects a binary with the wrong checksum without caching it', async () => {
        const cache = setupCache();
        const asset = assetName(process.platform, process.arch);
        const expectedBytes = Buffer.from('trusted Pumpkin binary');
        const actualBytes = Buffer.from('corrupted Pumpkin binary');
        const checksum = createHash('sha256').update(expectedBytes).digest('hex');
        const fetchMock = vi.fn<typeof fetch>(async (input) => {
            if (String(input).endsWith('/checksums.sha256')) return new Response(`${checksum}  ${asset}\n`);
            return new Response(actualBytes);
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(resolvePumpkinBinary()).rejects.toThrow(/Checksum mismatch/);
        expect(fs.readdirSync(cache)).toEqual([]);
    });

    it('explains when PUMPKIN_BIN points to a missing file', async () => {
        const cache = setupCache();
        const missing = path.join(cache, 'missing-pumpkin');
        const fetchMock = vi.fn<typeof fetch>();
        vi.stubEnv('PUMPKIN_BIN', missing);
        vi.stubGlobal('fetch', fetchMock);

        await expect(resolvePumpkinBinary()).rejects.toThrow(`PUMPKIN_BIN does not exist: ${missing}`);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
