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
    vi.stubEnv('PUMPKIN_API_TARGET', 'release');
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

    it('does not download an asset missing from the checksum list', async () => {
        const cache = setupCache();
        const asset = assetName(process.platform, process.arch);
        const fetchMock = vi.fn<typeof fetch>(async () => new Response(`${'f'.repeat(64)}  other-platform\n`));
        vi.stubGlobal('fetch', fetchMock);

        await expect(resolvePumpkinBinary()).rejects.toThrow(
            `checksums.sha256 for ${PUMPKIN_RELEASE} has no entry for ${asset}`
        );
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/checksums.sha256');
        expect(fs.readdirSync(cache)).toEqual([]);
    });

    it.each(['checksum list', 'binary asset'] as const)(
        'reports an HTTP error for the %s download',
        async (failedDownload) => {
            const cache = setupCache();
            const asset = assetName(process.platform, process.arch);
            const bytes = Buffer.from('test Pumpkin binary');
            const checksum = createHash('sha256').update(bytes).digest('hex');
            const fetchMock = vi.fn<typeof fetch>(async (input) => {
                const isChecksumList = String(input).endsWith('/checksums.sha256');
                if (isChecksumList && failedDownload === 'checksum list') return new Response(null, { status: 503 });
                if (!isChecksumList && failedDownload === 'binary asset') return new Response(null, { status: 503 });
                return new Response(`${checksum}  ${asset}\n`);
            });
            vi.stubGlobal('fetch', fetchMock);

            await expect(resolvePumpkinBinary()).rejects.toThrow(/HTTP 503/);
            expect(fetchMock).toHaveBeenCalledTimes(failedDownload === 'checksum list' ? 1 : 2);
            expect(fs.readdirSync(cache)).toEqual([]);
        }
    );
});

describe('pinned nightly binary', () => {
    it('uses the profile digest without fetching a checksum manifest and detects cache corruption', async () => {
        const cache = setupCache();
        vi.stubEnv('PUMPKIN_API_TARGET', 'nightly');
        const bytes = Buffer.from('test nightly server');
        const digest = createHash('sha256').update(bytes).digest('hex');
        const profiles = await import('../../../scripts/pumpkin-targets.mjs');
        const original = profiles.readTarget();
        const selected = {
            ...original,
            server: { ...original.server, sha256: { [assetName(process.platform, process.arch)]: digest } }
        };
        const profile = vi.spyOn(profiles, 'readTarget').mockReturnValue(selected);
        const requested: string[] = [];
        vi.stubGlobal('fetch', async (url: string) => {
            requested.push(String(url));
            return new Response(bytes);
        });
        try {
            const binary = await resolvePumpkinBinary();
            expect(binary).toContain(digest);
            expect(fs.readFileSync(binary)).toEqual(bytes);
            expect(requested).toHaveLength(1);
            expect(requested[0]).toContain('/nightly/');
            fs.writeFileSync(binary, 'corrupted cache');
            await expect(resolvePumpkinBinary()).rejects.toThrow(/Checksum mismatch/);
            expect(fs.readdirSync(cache)).toEqual([]);
        } finally {
            profile.mockRestore();
        }
    });
    it('rejects an unsupported platform pin before making any network request', async () => {
        setupCache();
        vi.stubEnv('PUMPKIN_API_TARGET', 'nightly');
        const profiles = await import('../../../scripts/pumpkin-targets.mjs');
        const original = profiles.readTarget();
        const profile = vi
            .spyOn(profiles, 'readTarget')
            .mockReturnValue({ ...original, server: { ...original.server, sha256: {} } });
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        try {
            await expect(resolvePumpkinBinary()).rejects.toThrow(/no pinned digest/i);
            expect(fetchMock).not.toHaveBeenCalled();
        } finally {
            profile.mockRestore();
        }
    });
});
