import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePumpkinBinary } from './binary.ts';
import { PUMPKIN_RELEASE } from './pumpkin-version.ts';
import { assetName, isMuslLinux } from './util.ts';

const asset = assetName(process.platform, process.arch, isMuslLinux());
const trustedBytes = Buffer.from('trusted Pumpkin binary');

// Pin the test binary's checksum in place of the real one.
const pins = vi.hoisted((): Record<string, string> => ({}));
vi.mock('./pumpkin-version.ts', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./pumpkin-version.ts')>()),
    PUMPKIN_RELEASE_SHA256: pins,
}));

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
    for (const key of Object.keys(pins)) delete pins[key];
    pins[asset] = createHash('sha256').update(trustedBytes).digest('hex');
    return dir;
}

describe('resolvePumpkinBinary', () => {
    it('downloads and verifies the binary once, then reuses the cache without the network', async () => {
        const cache = setupCache();
        const fetchMock = vi.fn<typeof fetch>(async () => new Response(trustedBytes));
        vi.stubGlobal('fetch', fetchMock);

        const expected = path.join(cache, `${PUMPKIN_RELEASE}-${asset}`);
        expect(await resolvePumpkinBinary()).toBe(expected);
        expect(fs.readFileSync(expected)).toEqual(trustedBytes);
        expect(fs.statSync(expected).mode & 0o777).toBe(0o755);
        expect(fetchMock).toHaveBeenCalledOnce();

        fetchMock.mockRejectedValue(new TypeError('fetch failed'));
        expect(await resolvePumpkinBinary()).toBe(expected);
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('rejects a cached binary that does not match the pinned checksum', async () => {
        const cache = setupCache();
        const corruptedBytes = Buffer.from('corrupted cached Pumpkin binary');
        const expected = path.join(cache, `${PUMPKIN_RELEASE}-${asset}`);
        fs.writeFileSync(expected, corruptedBytes);
        const fetchMock = vi.fn<typeof fetch>();
        vi.stubGlobal('fetch', fetchMock);

        await expect(resolvePumpkinBinary()).rejects.toThrow(/Checksum mismatch/);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(fs.readFileSync(expected)).toEqual(corruptedBytes);
    });

    it('rejects a binary with the wrong checksum without caching it', async () => {
        const cache = setupCache();
        vi.stubGlobal('fetch', async () => new Response(Buffer.from('corrupted Pumpkin binary')));

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

    it('does not download an asset without a pinned checksum', async () => {
        const cache = setupCache();
        delete pins[asset];
        const fetchMock = vi.fn<typeof fetch>();
        vi.stubGlobal('fetch', fetchMock);

        await expect(resolvePumpkinBinary()).rejects.toThrow(`No pinned SHA-256 for ${asset}`);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(fs.readdirSync(cache)).toEqual([]);
    });

    it('reports an HTTP error for the binary download', async () => {
        const cache = setupCache();
        vi.stubGlobal('fetch', async () => new Response(null, { status: 503 }));

        await expect(resolvePumpkinBinary()).rejects.toThrow(/HTTP 503/);
        expect(fs.readdirSync(cache)).toEqual([]);
    });
});
