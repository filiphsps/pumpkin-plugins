import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BuildError } from './errors.ts';
import { ensureWasiWit, readLock, type WasiWitLock } from './wasi-wit.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const FILES = { 'io/poll.wit': 'package wasi:io;', 'clocks/world.wit': 'package wasi:clocks;' };
const lock: WasiWitLock = {
    version: '9.9.9',
    files: Object.fromEntries(Object.entries(FILES).map(([k, v]) => [k, sha(v)]))
};

const dirs: string[] = [];
const tmp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasi-wit-'));
    dirs.push(dir);
    return dir;
};
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A downloader that serves FILES and records every URL asked for. */
function server(overrides: Record<string, string> = {}) {
    const urls: string[] = [];
    const fetchFile = async (url: string) => {
        urls.push(url);
        const rel = url.split('/wasip2/')[1];
        const body = overrides[rel] ?? FILES[rel as keyof typeof FILES];
        if (body === undefined) throw new Error('HTTP 404');
        return new TextEncoder().encode(body);
    };
    return { urls, fetchFile };
}

describe('ensureWasiWit', () => {
    it('downloads every pinned file from the tagged release into a versioned cache folder', async () => {
        const cache = tmp();
        const { urls, fetchFile } = server();
        const dir = await ensureWasiWit({ cacheDir: cache, lock, fetchFile });

        expect(dir).toBe(path.join(cache, 'wasi-wit', '9.9.9'));
        expect(fs.readFileSync(path.join(dir, 'io/poll.wit'), 'utf8')).toBe(FILES['io/poll.wit']);
        expect(fs.readFileSync(path.join(dir, 'clocks/world.wit'), 'utf8')).toBe(FILES['clocks/world.wit']);
        expect(urls.sort()).toEqual([
            'https://raw.githubusercontent.com/WebAssembly/WASI/v9.9.9/wasip2/clocks/world.wit',
            'https://raw.githubusercontent.com/WebAssembly/WASI/v9.9.9/wasip2/io/poll.wit'
        ]);
    });

    it('downloads nothing when the cache is complete', async () => {
        const cache = tmp();
        await ensureWasiWit({ cacheDir: cache, lock, fetchFile: server().fetchFile });
        const again = server();
        await ensureWasiWit({ cacheDir: cache, lock, fetchFile: again.fetchFile });
        expect(again.urls).toEqual([]);
    });

    it('replaces a cached file that was damaged, and only that one', async () => {
        const cache = tmp();
        const dir = await ensureWasiWit({ cacheDir: cache, lock, fetchFile: server().fetchFile });
        fs.writeFileSync(path.join(dir, 'io/poll.wit'), 'tampered');

        const again = server();
        await ensureWasiWit({ cacheDir: cache, lock, fetchFile: again.fetchFile });
        expect(again.urls).toHaveLength(1);
        expect(fs.readFileSync(path.join(dir, 'io/poll.wit'), 'utf8')).toBe(FILES['io/poll.wit']);
    });

    it('refuses a download that does not match its pinned hash and does not cache it', async () => {
        const cache = tmp();
        await expect(
            ensureWasiWit({ cacheDir: cache, lock, fetchFile: server({ 'io/poll.wit': 'evil' }).fetchFile })
        ).rejects.toThrow(/io\/poll\.wit .* has hash .*, expected /);
        expect(fs.existsSync(path.join(cache, 'wasi-wit', '9.9.9', 'io/poll.wit'))).toBe(false);
    });

    it('says what to do when there is no network on the first build', async () => {
        const fetchFile = async () => {
            throw new Error('getaddrinfo ENOTFOUND');
        };
        const result = ensureWasiWit({ cacheDir: tmp(), lock, fetchFile });
        await expect(result).rejects.toBeInstanceOf(BuildError);
        await expect(result).rejects.toThrow(/first build needs network access/);
    });
});

describe('readLock', () => {
    it('pins every file by a SHA-256 hash', () => {
        const real = readLock();
        expect(real.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(Object.keys(real.files).length).toBeGreaterThan(0);
        for (const hash of Object.values(real.files)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
});
