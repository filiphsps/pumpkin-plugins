import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BuildError } from './errors.ts';

const WIT_LOCK_TIMEOUT_MS = 30_000;
const WIT_LOCK_RETRY_MS = 25;
const WIT_LOCK_STALE_MS = 60_000;

/**
 * Run an operation while holding the exclusive WASI WIT cache lock.
 *
 * @internal
 * @param lockPath - Cache lock file path.
 * @param operation - Operation to execute while holding the lock.
 * @returns The result returned by the operation.
 */
export async function withWasiWitFileLock<T>(lockPath: string, operation: () => T | Promise<T>): Promise<T> {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const ownerToken = randomUUID();
    const reclaimLockPath = `${lockPath}.reclaim`;
    const deadline = Date.now() + WIT_LOCK_TIMEOUT_MS;

    while (true) {
        try {
            writeWasiWitLock(lockPath, ownerToken);
            break;
        } catch (error) {
            if (errorCode(error) !== 'EEXIST') throw error;
            if (isStaleWasiWitLock(lockPath)) {
                const reclaimToken = tryAcquireWasiWitReclaimLock(reclaimLockPath);
                if (reclaimToken !== null) {
                    let acquiredLock = false;
                    try {
                        if (isStaleWasiWitLock(lockPath)) {
                            fs.rmSync(lockPath, { force: true });
                            try {
                                writeWasiWitLock(lockPath, ownerToken);
                                acquiredLock = true;
                            } catch (writeError) {
                                if (errorCode(writeError) !== 'EEXIST') throw writeError;
                            }
                        }
                    } finally {
                        releaseWasiWitFileLock(reclaimLockPath, reclaimToken);
                    }
                    if (acquiredLock) return operationWithWasiWitLock(lockPath, ownerToken, operation);
                    continue;
                }
            }
            if (Date.now() >= deadline) {
                if (fs.existsSync(reclaimLockPath)) {
                    throw new BuildError(
                        `timed out waiting for the WASI WIT cache lock at ${lockPath}; inspect recovery claim ${reclaimLockPath} and remove it only after confirming no recovery is active`
                    );
                }
                throw new BuildError(`timed out waiting for the WASI WIT cache lock at ${lockPath}`);
            }
            await new Promise<void>((resolve) => setTimeout(resolve, WIT_LOCK_RETRY_MS));
        }
    }

    return operationWithWasiWitLock(lockPath, ownerToken, operation);
}

async function operationWithWasiWitLock<T>(
    lockPath: string,
    ownerToken: string,
    operation: () => T | Promise<T>
): Promise<T> {
    try {
        return await operation();
    } finally {
        releaseWasiWitFileLock(lockPath, ownerToken);
    }
}

function writeWasiWitLock(lockPath: string, ownerToken: string): void {
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
                removeWasiWitLockIfOwned(lockPath, createdFile);
            } catch (cleanupError) {
                throw new AggregateError([error, cleanupError], 'failed to write and clean up the WASI WIT lock', {
                    cause: error
                });
            }
        }
        throw error;
    }
}

function removeWasiWitLockIfOwned(lockPath: string, createdFile: fs.Stats): void {
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

function tryAcquireWasiWitReclaimLock(lockPath: string): string | null {
    const ownerToken = randomUUID();
    try {
        writeWasiWitLock(lockPath, ownerToken);
        return ownerToken;
    } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        if (!removeStaleWasiWitLock(lockPath)) return null;
        try {
            writeWasiWitLock(lockPath, ownerToken);
            return ownerToken;
        } catch (writeError) {
            if (errorCode(writeError) === 'EEXIST') return null;
            throw writeError;
        }
    }
}

function removeStaleWasiWitLock(lockPath: string): boolean {
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
    if (!isStaleWasiWitLock(lockPath)) return false;

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
    if (currentContents !== originalContents || !isStaleWasiWitLock(lockPath)) return false;

    fs.rmSync(lockPath, { force: true });
    return true;
}

function isStaleWasiWitLock(lockPath: string): boolean {
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

    return Date.now() - fs.statSync(lockPath).mtimeMs > WIT_LOCK_STALE_MS;
}

function releaseWasiWitFileLock(lockPath: string, ownerToken: string): void {
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
