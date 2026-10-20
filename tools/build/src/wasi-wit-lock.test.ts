import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withFileLock } from './wasi-wit-lock.ts';

const filesystemState = vi.hoisted(() => ({
    onRemoveLock: undefined as ((filename: string) => void) | undefined,
    failLockWrite: undefined as { lockPath: string; replacement?: string } | undefined,
}));
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
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
        rmSync: (...args: Parameters<typeof actual.rmSync>) => {
            filesystemState.onRemoveLock?.(String(args[0]));
            return actual.rmSync(...args);
        },
    };
});

const dirs: string[] = [];
const tmp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-'));
    dirs.push(dir);
    return dir;
};
afterEach(() => {
    filesystemState.onRemoveLock = undefined;
    filesystemState.failLockWrite = undefined;
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('withFileLock', () => {
    it('names only the locked path when it times out waiting for a live owner', async () => {
        const lockPath = path.join(tmp(), 'build', '.wit-publish.lock');
        fs.mkdirSync(path.dirname(lockPath));
        fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'live' }));
        vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValue(1_000_000);

        const result = withFileLock(lockPath, () => undefined);

        await expect(result).rejects.toThrow(`timed out waiting for the lock at ${lockPath}`);
        await expect(result).rejects.not.toThrow(/WASI/);
    });

    it('removes a partially written lock after the lock write fails', async () => {
        const lockPath = path.join(tmp(), 'cache.lock');
        filesystemState.failLockWrite = { lockPath };

        await expect(withFileLock(lockPath, () => undefined)).rejects.toThrow('injected lock write failure');

        expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('keeps a replacement lock when the original lock write fails', async () => {
        const lockPath = path.join(tmp(), 'cache.lock');
        const replacement = JSON.stringify({ pid: 123, token: 'replacement' });
        filesystemState.failLockWrite = { lockPath, replacement };

        await expect(withFileLock(lockPath, () => undefined)).rejects.toThrow('injected lock write failure');

        expect(fs.readFileSync(lockPath, 'utf8')).toBe(replacement);
    });

    it('recovers a stale lock when its recovery owner has exited', async () => {
        const lockPath = path.join(tmp(), 'cache.lock');
        const reclaimLockPath = `${lockPath}.reclaim`;
        const staleOwner = JSON.stringify({ pid: 99999999, token: 'stale' });
        fs.writeFileSync(lockPath, staleOwner);
        fs.writeFileSync(reclaimLockPath, JSON.stringify({ pid: 99999998, token: 'abandoned-recovery' }));
        vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_001).mockReturnValue(1_000_000);

        await expect(withFileLock(lockPath, () => 'recovered')).resolves.toBe('recovered');

        expect(fs.existsSync(lockPath)).toBe(false);
        expect(fs.existsSync(reclaimLockPath)).toBe(false);
    });

    it('keeps a live recovery owner while waiting for a stale lock', async () => {
        const lockPath = path.join(tmp(), 'cache.lock');
        const reclaimLockPath = `${lockPath}.reclaim`;
        const staleOwner = JSON.stringify({ pid: 99999999, token: 'stale' });
        const liveRecoveryOwner = JSON.stringify({ pid: process.pid, token: 'live-recovery' });
        fs.writeFileSync(lockPath, staleOwner);
        fs.writeFileSync(reclaimLockPath, liveRecoveryOwner);
        const now = vi.spyOn(Date, 'now');
        now.mockReturnValueOnce(1_000).mockReturnValueOnce(1_001).mockReturnValue(1_000_000);

        await expect(withFileLock(lockPath, () => undefined)).rejects.toThrow(
            `inspect recovery claim ${reclaimLockPath}`,
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
                second = withFileLock(lockPath, async () => {
                    operations.push('second:start');
                    signalSecondEntered();
                    await secondGate;
                    operations.push('second:end');
                });
            }
        };

        const first = withFileLock(lockPath, async () => {
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
});
