import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BuildError } from './errors.ts';
import { ensureWasiWit, readLock, type WasiWitLock } from './wasi-wit.ts';
import { withWasiWitFileLock } from './wasi-wit-lock.ts';

const filesystemState = vi.hoisted(() => ({
    rejectRenameOverExistingFile: false,
    onRemoveLock: undefined as ((filename: string) => void) | undefined,
    failLockWrite: undefined as { lockPath: string; replacement?: string } | undefined,
    failReadPath: undefined as string | undefined
}));
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
            const [file] = args;
            if (
                filesystemState.failReadPath !== undefined &&
                typeof file !== 'number' &&
                path.resolve(String(file)) === path.resolve(filesystemState.failReadPath)
            ) {
                throw Object.assign(new Error('injected read failure'), { code: 'EACCES' });
            }
            return actual.readFileSync(...args);
        },
        writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
            const failure = filesystemState.failLockWrite;
            if (failure !== undefined) {
                filesystemState.failLockWrite = undefined;
                const [file] = args;
                if (typeof file === 'number') {
                    actual.writeFileSync(file, '{"pid":');
                    if (failure.replacement !== undefined) {
                        actual.closeSync(file);
                        actual.rmSync(failure.lockPath, { force: true });
                        actual.writeFileSync(failure.lockPath, failure.replacement, { flag: 'wx' });
                    }
                } else {
                    actual.writeFileSync(file, '{"pid":', { flag: 'wx' });
                    if (failure.replacement !== undefined) {
                        actual.rmSync(failure.lockPath, { force: true });
                        actual.writeFileSync(failure.lockPath, failure.replacement, { flag: 'wx' });
                    }
                }
                throw new Error('injected lock write failure');
            }
            return actual.writeFileSync(...args);
        },
        renameSync: (...args: Parameters<typeof actual.renameSync>) => {
            if (filesystemState.rejectRenameOverExistingFile && actual.existsSync(args[1])) {
                throw Object.assign(new Error('destination already exists'), { code: 'EEXIST' });
            }
            return actual.renameSync(...args);
        },
        rmSync: (...args: Parameters<typeof actual.rmSync>) => {
            filesystemState.onRemoveLock?.(String(args[0]));
            return actual.rmSync(...args);
        }
    };
});

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
    filesystemState.rejectRenameOverExistingFile = false;
    filesystemState.onRemoveLock = undefined;
    filesystemState.failLockWrite = undefined;
    filesystemState.failReadPath = undefined;
    vi.restoreAllMocks();
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
    it('rejects a cache-escaping lock version before downloading or writing files', async () => {
        const cache = tmp();
        const escapedFolder = `${path.basename(cache)}-version-escape`;
        const escapedFile = path.join(os.tmpdir(), escapedFolder, 'io/poll.wit');
        fs.rmSync(path.dirname(escapedFile), { recursive: true, force: true });
        const download = server();
        let fetchCount = 0;

        try {
            await expect(
                ensureWasiWit({
                    cacheDir: cache,
                    lock: { ...lock, version: `../../${escapedFolder}` },
                    fetchFile: async (url) => {
                        fetchCount += 1;
                        return download.fetchFile(url);
                    }
                })
            ).rejects.toThrow(/unsafe WASI WIT lock version/);

            expect(fetchCount).toBe(0);
            expect(fs.existsSync(escapedFile)).toBe(false);
            expect(fs.existsSync(path.join(cache, 'wasi-wit'))).toBe(false);
        } finally {
            fs.rmSync(path.join(os.tmpdir(), escapedFolder), { recursive: true, force: true });
        }
    });

    it('rejects a cache-escaping WIT file key before writing generated content', async () => {
        const cache = tmp();
        const escapedFile = path.join(os.tmpdir(), `${path.basename(cache)}-file-escape.wit`);
        const rel = `../../../${path.basename(cache)}-file-escape.wit`;
        fs.rmSync(escapedFile, { force: true });

        try {
            await expect(
                ensureWasiWit({
                    cacheDir: cache,
                    lock: {
                        version: '9.9.9',
                        files: { [rel]: sha('package wasi:evil;') },
                        generatedFiles: { [rel]: 'package wasi:evil;' }
                    },
                    fetchFile: async () => {
                        throw new Error('unexpected download');
                    }
                })
            ).rejects.toThrow(/unsafe WASI WIT file path/);

            expect(fs.existsSync(escapedFile)).toBe(false);
            expect(fs.existsSync(path.join(cache, 'wasi-wit'))).toBe(false);
        } finally {
            fs.rmSync(escapedFile, { force: true });
        }
    });

    it('rejects Windows path separators in WIT keys on every platform', async () => {
        const cache = tmp();
        const rel = `..\\..\\${path.basename(cache)}-windows-escape.wit`;
        const escapedFile = path.resolve(cache, 'wasi-wit', '9.9.9', rel);
        fs.rmSync(escapedFile, { force: true });

        try {
            await expect(
                ensureWasiWit({
                    cacheDir: cache,
                    lock: {
                        version: '9.9.9',
                        files: { [rel]: sha('package wasi:evil;') },
                        generatedFiles: { [rel]: 'package wasi:evil;' }
                    },
                    fetchFile: async () => {
                        throw new Error('unexpected download');
                    }
                })
            ).rejects.toThrow(/unsafe WASI WIT file path/);

            expect(fs.existsSync(escapedFile)).toBe(false);
        } finally {
            fs.rmSync(escapedFile, { force: true });
        }
    });

    it('rejects unsafe alternate-source keys before accessing the cache or network', async () => {
        const cache = tmp();
        let fetchCount = 0;

        await expect(
            ensureWasiWit({
                cacheDir: cache,
                lock: { ...lock, sources: { '../unlisted.wit': 'https://example.test/unlisted.wit' } },
                fetchFile: async () => {
                    fetchCount += 1;
                    return new TextEncoder().encode('unexpected download');
                }
            })
        ).rejects.toThrow(/unsafe WASI WIT source path/);

        expect(fetchCount).toBe(0);
        expect(fs.existsSync(path.join(cache, 'wasi-wit'))).toBe(false);
    });

    it('rejects unsafe generated-file keys before checking the files lock', async () => {
        const cache = tmp();
        let fetchCount = 0;

        await expect(
            ensureWasiWit({
                cacheDir: cache,
                lock: { ...lock, generatedFiles: { '../unlisted.wit': 'package wasi:evil;' } },
                fetchFile: async () => {
                    fetchCount += 1;
                    return new TextEncoder().encode('unexpected download');
                }
            })
        ).rejects.toThrow(/unsafe WASI WIT generated-file path/);

        expect(fetchCount).toBe(0);
        expect(fs.existsSync(path.join(cache, 'wasi-wit'))).toBe(false);
    });

    it('removes a partially written lock after the lock write fails', async () => {
        const lockPath = path.join(tmp(), 'cache.lock');
        filesystemState.failLockWrite = { lockPath };

        await expect(withWasiWitFileLock(lockPath, () => undefined)).rejects.toThrow('injected lock write failure');

        expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('keeps a replacement lock when the original lock write fails', async () => {
        const lockPath = path.join(tmp(), 'cache.lock');
        const replacement = JSON.stringify({ pid: 123, token: 'replacement' });
        filesystemState.failLockWrite = { lockPath, replacement };

        await expect(withWasiWitFileLock(lockPath, () => undefined)).rejects.toThrow('injected lock write failure');

        expect(fs.readFileSync(lockPath, 'utf8')).toBe(replacement);
    });

    it('recovers a stale WIT cache lock when its recovery owner has exited', async () => {
        const lockPath = path.join(tmp(), 'cache.lock');
        const reclaimLockPath = `${lockPath}.reclaim`;
        const staleOwner = JSON.stringify({ pid: 99999999, token: 'stale' });
        fs.writeFileSync(lockPath, staleOwner);
        fs.writeFileSync(reclaimLockPath, JSON.stringify({ pid: 99999998, token: 'abandoned-recovery' }));
        vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_001).mockReturnValue(1_000_000);

        await expect(withWasiWitFileLock(lockPath, () => 'recovered')).resolves.toBe('recovered');

        expect(fs.existsSync(lockPath)).toBe(false);
        expect(fs.existsSync(reclaimLockPath)).toBe(false);
    });

    it('keeps a live WIT recovery owner while waiting for a stale cache lock', async () => {
        const lockPath = path.join(tmp(), 'cache.lock');
        const reclaimLockPath = `${lockPath}.reclaim`;
        const staleOwner = JSON.stringify({ pid: 99999999, token: 'stale' });
        const liveRecoveryOwner = JSON.stringify({ pid: process.pid, token: 'live-recovery' });
        fs.writeFileSync(lockPath, staleOwner);
        fs.writeFileSync(reclaimLockPath, liveRecoveryOwner);
        const now = vi.spyOn(Date, 'now');
        now.mockReturnValueOnce(1_000).mockReturnValueOnce(1_001).mockReturnValue(1_000_000);

        await expect(withWasiWitFileLock(lockPath, () => undefined)).rejects.toThrow(
            `inspect recovery claim ${reclaimLockPath}`
        );

        expect(fs.readFileSync(lockPath, 'utf8')).toBe(staleOwner);
        expect(fs.readFileSync(reclaimLockPath, 'utf8')).toBe(liveRecoveryOwner);
    });

    it('does not let a stale-lock waiter delete the replacement lock', async () => {
        const cache = tmp();
        const lockPath = path.join(cache, 'cache.lock');
        fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999, token: 'stale' }));
        const operations: string[] = [];
        let signalFirstEntered = (): void => undefined;
        let releaseFirst = (): void => undefined;
        let signalSecondEntered = (): void => undefined;
        let releaseSecond = (): void => undefined;
        const firstEntered = new Promise<void>((resolve) => {
            signalFirstEntered = resolve;
        });
        const secondEntered = new Promise<void>((resolve) => {
            signalSecondEntered = resolve;
        });
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const secondGate = new Promise<void>((resolve) => {
            releaseSecond = resolve;
        });
        let second: Promise<void> | undefined;
        let injectedSecondWaiter = false;
        filesystemState.onRemoveLock = (filename) => {
            if (!injectedSecondWaiter && path.resolve(filename) === lockPath) {
                injectedSecondWaiter = true;
                second = withWasiWitFileLock(lockPath, async () => {
                    operations.push('second:start');
                    signalSecondEntered();
                    await secondGate;
                    operations.push('second:end');
                });
            }
        };

        const first = withWasiWitFileLock(lockPath, async () => {
            operations.push('first:start');
            signalFirstEntered();
            await firstGate;
            operations.push('first:end');
        });

        try {
            await firstEntered;
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(operations).toEqual(['first:start']);

            releaseFirst();
            await secondEntered;
            expect(operations).toEqual(['first:start', 'first:end', 'second:start']);
            releaseSecond();
            await Promise.all([first, second]);

            expect(operations).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
            expect(fs.existsSync(lockPath)).toBe(false);
            expect(fs.existsSync(`${lockPath}.reclaim`)).toBe(false);
        } finally {
            releaseFirst();
            releaseSecond();
            await Promise.allSettled([first, ...(second ? [second] : [])]);
        }
    });

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

    it('writes generated WIT files from the lock without downloading them', async () => {
        const cache = tmp();
        const packageWit = 'package wasi:http@0.2.3;\n';
        const generatedLock = {
            version: '9.9.9',
            files: { 'http/package.wit': sha(packageWit) },
            generatedFiles: { 'http/package.wit': packageWit }
        } satisfies WasiWitLock;
        let fetchCount = 0;

        const dir = await ensureWasiWit({
            cacheDir: cache,
            lock: generatedLock,
            fetchFile: async () => {
                fetchCount += 1;
                return new TextEncoder().encode('unexpected download');
            }
        });

        expect(fetchCount).toBe(0);
        expect(fs.readFileSync(path.join(dir, 'http/package.wit'), 'utf8')).toBe(packageWit);
    });

    it('downloads nothing when the cache is complete', async () => {
        const cache = tmp();
        await ensureWasiWit({ cacheDir: cache, lock, fetchFile: server().fetchFile });
        const again = server();
        await ensureWasiWit({ cacheDir: cache, lock, fetchFile: again.fetchFile });
        expect(again.urls).toEqual([]);
    });

    it('leaves complete cache files when concurrent builds fill an empty cache', async () => {
        const cache = tmp();
        const { fetchFile } = server();

        await Promise.all(Array.from({ length: 8 }, () => ensureWasiWit({ cacheDir: cache, lock, fetchFile })));

        const dir = path.join(cache, 'wasi-wit', lock.version);
        for (const [file, content] of Object.entries(FILES)) {
            expect(fs.readFileSync(path.join(dir, file), 'utf8')).toBe(content);
        }
        expect(fs.readdirSync(path.join(dir, 'io')).filter((name) => name.startsWith('.wasi-wit-'))).toEqual([]);
    });

    it('publishes concurrent first fills when rename cannot replace an existing file', async () => {
        const cache = tmp();
        const workerCount = 8;
        let fetchCount = 0;
        let allDownloadsStarted!: () => void;
        const downloadsStarted = new Promise<void>((resolve) => {
            allDownloadsStarted = resolve;
        });
        const fetchFile = async (url: string) => {
            fetchCount += 1;
            if (fetchCount === workerCount * Object.keys(FILES).length) allDownloadsStarted();
            await downloadsStarted;
            const rel = url.split('/wasip2/')[1];
            return new TextEncoder().encode(FILES[rel as keyof typeof FILES]);
        };
        filesystemState.rejectRenameOverExistingFile = true;

        const results = await Promise.all(
            Array.from({ length: workerCount }, () => ensureWasiWit({ cacheDir: cache, lock, fetchFile }))
        );

        expect(new Set(results).size).toBe(1);
        const dir = results[0];
        for (const [file, content] of Object.entries(FILES)) {
            expect(fs.readFileSync(path.join(dir, file), 'utf8')).toBe(content);
        }
    });

    it('keeps atomic staging directories outside the WIT tree while filling the cache', async () => {
        const cache = tmp();
        const wit = path.join(cache, 'wasi-wit', lock.version);
        const watched = ['io', 'clocks'].map((folder) => path.join(wit, folder));
        for (const folder of watched) fs.mkdirSync(folder, { recursive: true });

        const stagingEvents: string[] = [];
        const watchers = watched.map((folder) =>
            fs.watch(folder, (_event, filename) => {
                if (filename?.toString().startsWith('.wasi-wit-')) stagingEvents.push(filename.toString());
            })
        );
        try {
            await ensureWasiWit({ cacheDir: cache, lock, fetchFile: server().fetchFile });
            await new Promise((resolve) => setTimeout(resolve, 10));
        } finally {
            for (const watcher of watchers) watcher.close();
        }

        expect(stagingEvents).toEqual([]);
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

    it('replaces an unexpected directory at a cached WIT file path without changing valid siblings', async () => {
        const cache = tmp();
        const dir = path.join(cache, 'wasi-wit', lock.version);
        const damagedFile = path.join(dir, 'io/poll.wit');
        const validSibling = path.join(dir, 'clocks/world.wit');
        fs.mkdirSync(path.join(damagedFile, 'nested'), { recursive: true });
        fs.writeFileSync(path.join(damagedFile, 'nested', 'marker'), 'stale directory data');
        fs.mkdirSync(path.dirname(validSibling), { recursive: true });
        fs.writeFileSync(validSibling, FILES['clocks/world.wit']);
        const download = server();

        await ensureWasiWit({ cacheDir: cache, lock, fetchFile: download.fetchFile });

        expect(download.urls).toEqual(['https://raw.githubusercontent.com/WebAssembly/WASI/v9.9.9/wasip2/io/poll.wit']);
        expect(fs.readFileSync(damagedFile, 'utf8')).toBe(FILES['io/poll.wit']);
        expect(fs.readFileSync(validSibling, 'utf8')).toBe(FILES['clocks/world.wit']);
    });

    it('repairs an unreadable cached WIT file', async () => {
        const cache = tmp();
        const dir = path.join(cache, 'wasi-wit', lock.version);
        const damagedFile = path.join(dir, 'io/poll.wit');
        const validSibling = path.join(dir, 'clocks/world.wit');
        fs.mkdirSync(path.dirname(damagedFile), { recursive: true });
        fs.mkdirSync(path.dirname(validSibling), { recursive: true });
        fs.writeFileSync(damagedFile, FILES['io/poll.wit']);
        fs.writeFileSync(validSibling, FILES['clocks/world.wit']);
        filesystemState.failReadPath = damagedFile;
        const download = server();

        await ensureWasiWit({ cacheDir: cache, lock, fetchFile: download.fetchFile });
        filesystemState.failReadPath = undefined;

        expect(download.urls).toEqual(['https://raw.githubusercontent.com/WebAssembly/WASI/v9.9.9/wasip2/io/poll.wit']);
        expect(fs.readFileSync(damagedFile, 'utf8')).toBe(FILES['io/poll.wit']);
        expect(fs.readFileSync(validSibling, 'utf8')).toBe(FILES['clocks/world.wit']);
    });

    it('replaces a non-regular cached entry without following its symlink target', async () => {
        const cache = tmp();
        const dir = path.join(cache, 'wasi-wit', lock.version);
        const damagedFile = path.join(dir, 'io/poll.wit');
        const target = path.join(cache, 'outside.wit');
        fs.mkdirSync(path.dirname(damagedFile), { recursive: true });
        fs.writeFileSync(target, FILES['io/poll.wit']);
        fs.symlinkSync(target, damagedFile);
        const download = server();

        await ensureWasiWit({ cacheDir: cache, lock, fetchFile: download.fetchFile });

        expect(fs.lstatSync(damagedFile).isFile()).toBe(true);
        expect(fs.readFileSync(damagedFile, 'utf8')).toBe(FILES['io/poll.wit']);
        expect(fs.readFileSync(target, 'utf8')).toBe(FILES['io/poll.wit']);
    });

    it('repairs a corrupt cached file when rename cannot replace an existing file', async () => {
        const cache = tmp();
        const dir = path.join(cache, 'wasi-wit', lock.version);
        fs.mkdirSync(path.join(dir, 'io'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'clocks'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'io/poll.wit'), 'tampered');
        fs.writeFileSync(path.join(dir, 'clocks/world.wit'), FILES['clocks/world.wit']);
        filesystemState.rejectRenameOverExistingFile = true;

        await ensureWasiWit({ cacheDir: cache, lock, fetchFile: server().fetchFile });

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
        for (const [file, content] of Object.entries(real.generatedFiles ?? {})) {
            expect(real.files[file]).toBe(sha(content));
        }
    });
});
