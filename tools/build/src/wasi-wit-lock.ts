import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BuildError } from './errors.ts';

const LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 60_000;

/**
 * Runs an operation while holding an exclusive lock file shared with other build processes.
 *
 * @internal
 * @param lockPath - Lock file path.
 * @param operation - Operation to execute while holding the lock.
 * @returns The result returned by the operation.
 */
export async function withFileLock<T>(lockPath: string, operation: () => T | Promise<T>): Promise<T> {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const ownerToken = randomUUID();
    const reclaimLockPath = `${lockPath}.reclaim`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    while (true) {
        try {
            writeLock(lockPath, ownerToken);
            break;
        } catch (error) {
            if (errorCode(error) !== 'EEXIST') throw error;
            if (isStaleLock(lockPath)) {
                const reclaimToken = tryAcquireReclaimLock(reclaimLockPath);
                if (reclaimToken !== null) {
                    let acquiredLock = false;
                    try {
                        if (isStaleLock(lockPath)) {
                            fs.rmSync(lockPath, { force: true });
                            try {
                                writeLock(lockPath, ownerToken);
                                acquiredLock = true;
                            } catch (writeError) {
                                if (errorCode(writeError) !== 'EEXIST') throw writeError;
                            }
                        }
                    } finally {
                        releaseFileLock(reclaimLockPath, reclaimToken);
                    }
                    if (acquiredLock) return operationWithLock(lockPath, ownerToken, operation);
                    continue;
                }
            }
            if (Date.now() >= deadline) {
                if (fs.existsSync(reclaimLockPath)) {
                    throw new BuildError(
                        `timed out waiting for the lock at ${lockPath}; inspect recovery claim ${reclaimLockPath} and remove it only after confirming no recovery is active`,
                    );
                }
                throw new BuildError(`timed out waiting for the lock at ${lockPath}`);
            }
            await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
        }
    }

    return operationWithLock(lockPath, ownerToken, operation);
}

async function operationWithLock<T>(lockPath: string, ownerToken: string, operation: () => T | Promise<T>): Promise<T> {
    try {
        return await operation();
    } finally {
        releaseFileLock(lockPath, ownerToken);
    }
}

function writeLock(lockPath: string, ownerToken: string): void {
    const fileDescriptor = fs.openSync(lockPath, 'wx');
    let createdFile: fs.Stats | undefined;

    try {
        createdFile = fs.fstatSync(fileDescriptor);
        fs.writeFileSync(fileDescriptor, JSON.stringify({ pid: process.pid, token: ownerToken }));
        fs.closeSync(fileDescriptor);
    } catch (error) {
        try {
            fs.closeSync(fileDescriptor);
        } catch {
            // Preserve the write error; the descriptor may already have been closed.
        }

        if (createdFile !== undefined) {
            try {
                removeLockIfOwned(lockPath, createdFile);
            } catch (cleanupError) {
                throw new AggregateError(
                    [error, cleanupError],
                    `failed to write and clean up the lock at ${lockPath}`,
                    {
                        cause: error,
                    },
                );
            }
        }
        throw error;
    }
}

function removeLockIfOwned(lockPath: string, createdFile: fs.Stats): void {
    let currentFile: fs.Stats;
    try {
        currentFile = fs.lstatSync(lockPath);
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return;
        throw error;
    }

    if (currentFile.isFile() && currentFile.dev === createdFile.dev && currentFile.ino === createdFile.ino) {
        fs.rmSync(lockPath, { force: true });
    }
}

function tryAcquireReclaimLock(lockPath: string): string | null {
    const ownerToken = randomUUID();
    try {
        writeLock(lockPath, ownerToken);
        return ownerToken;
    } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        if (!removeStaleLock(lockPath)) return null;
        try {
            writeLock(lockPath, ownerToken);
            return ownerToken;
        } catch (writeError) {
            if (errorCode(writeError) === 'EEXIST') return null;
            throw writeError;
        }
    }
}

function removeStaleLock(lockPath: string): boolean {
    let originalFile: fs.Stats;
    try {
        originalFile = fs.lstatSync(lockPath);
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return true;
        throw error;
    }

    let originalContents: string;
    try {
        originalContents = fs.readFileSync(lockPath, 'utf8');
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return true;
        throw error;
    }
    if (!isStaleLock(lockPath)) return false;

    let currentFile: fs.Stats;
    try {
        currentFile = fs.lstatSync(lockPath);
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return true;
        throw error;
    }
    if (currentFile.dev !== originalFile.dev || currentFile.ino !== originalFile.ino) return false;

    let currentContents: string;
    try {
        currentContents = fs.readFileSync(lockPath, 'utf8');
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return true;
        throw error;
    }
    if (currentContents !== originalContents || !isStaleLock(lockPath)) return false;

    fs.rmSync(lockPath, { force: true });
    return true;
}

function isStaleLock(lockPath: string): boolean {
    let contents: string;
    try {
        contents = fs.readFileSync(lockPath, 'utf8');
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return true;
        throw error;
    }

    try {
        const owner = JSON.parse(contents) as { pid?: unknown };
        if (typeof owner.pid === 'number' && Number.isInteger(owner.pid) && owner.pid > 0) {
            try {
                process.kill(owner.pid, 0);
                return false;
            } catch (error) {
                return errorCode(error) === 'ESRCH';
            }
        }
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
    }

    return Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS;
}

function releaseFileLock(lockPath: string, ownerToken: string): void {
    let contents: string;
    try {
        contents = fs.readFileSync(lockPath, 'utf8');
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return;
        throw error;
    }

    try {
        const owner = JSON.parse(contents) as { token?: unknown };
        if (owner.token === ownerToken) fs.rmSync(lockPath, { force: true });
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
    }
}

function errorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
    return typeof error.code === 'string' ? error.code : undefined;
}
