import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const upstreamGitPinSchema =
    'https://raw.githubusercontent.com/filiphsps/pumpkin-plugins/master/tools/pumpkin-api/schemas/upstream-git-pin.schema.json';
const lockWait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const staleLockAgeMs = 30_000;
const maxLockWaitMs = 15 * 60_000;

/**
 * Fetch the pinned Pumpkin WIT subdirectory on first use and when its lockfile changes.
 *
 * The cache directory is keyed by the SHA-256 digest of the complete lockfile, so a change to
 * any lock field cannot reuse files from another pin. WIT is copied out of the temporary Git
 * checkout and the checkout is removed before the cache is published. Cached WIT files are
 * verified against their SHA-256 manifest before reuse, so a modified cache cannot change API bindings.
 *
 * @param {{ lockFile: string, cacheRoot: string }} options Lockfile path and consumer-owned cache root.
 * @returns The cached WIT package directory selected by the lockfile.
 * @throws {Error} If the lock is invalid, Git cannot fetch its commit, or the commit lacks WIT files.
 */
export function ensurePumpkinWit({ lockFile, cacheRoot }) {
    const lockSource = readLockSource(lockFile);
    const pin = parsePumpkinWitPin(lockSource, lockFile);
    const lockDigest = createHash('sha256').update(lockSource).digest('hex');
    const resolvedCacheRoot = path.resolve(cacheRoot);
    assertCacheRootIsExternal(resolvedCacheRoot);

    const cacheParent = path.join(resolvedCacheRoot, 'pumpkin-api-wit');
    const cacheDirectory = path.join(cacheParent, lockDigest);
    const cachedWit = path.join(cacheDirectory, pin.subdirectory);
    if (isValidCache(cacheDirectory, cachedWit, lockDigest, pin.commit, pin.subdirectory)) return cachedWit;

    fs.mkdirSync(cacheParent, { recursive: true });
    const releaseLock = acquireCacheLock(
        cacheParent,
        cacheDirectory,
        cachedWit,
        lockDigest,
        pin.commit,
        pin.subdirectory
    );
    if (!releaseLock) return cachedWit;

    try {
        if (isValidCache(cacheDirectory, cachedWit, lockDigest, pin.commit, pin.subdirectory)) return cachedWit;
        fs.rmSync(cacheDirectory, { recursive: true, force: true });
        const stagingDirectory = fs.mkdtempSync(path.join(cacheParent, '.staging-'));

        try {
            const checkout = path.join(stagingDirectory, 'checkout');
            // End option parsing so a validated remote cannot be interpreted as a Git option.
            runGit(['clone', '--filter=blob:none', '--no-checkout', '--', pin.repository, checkout]);
            runGit(['-C', checkout, 'fetch', '--depth', '1', 'origin', pin.commit]);
            runGit(['-C', checkout, 'checkout', '--quiet', '--detach', pin.commit]);

            const checkedOutCommit = runGit(['-C', checkout, 'rev-parse', 'HEAD']).toLowerCase();
            if (checkedOutCommit !== pin.commit) {
                throw new Error(`Git checked out ${checkedOutCommit}, expected ${pin.commit}`);
            }

            const sourceWit = path.join(checkout, pin.subdirectory);
            if (!hasWitFiles(sourceWit)) {
                throw new Error(`upstream commit ${pin.commit} does not contain WIT files under ${pin.subdirectory}/`);
            }

            const stagedWit = path.join(stagingDirectory, pin.subdirectory);
            fs.mkdirSync(path.dirname(stagedWit), { recursive: true });
            fs.cpSync(sourceWit, stagedWit, { recursive: true });
            fs.writeFileSync(
                path.join(stagingDirectory, 'pin.json'),
                `${JSON.stringify({ lockDigest, ...pin, witFiles: getWitFileManifest(stagedWit) }, null, 4)}\n`
            );
            fs.rmSync(checkout, { recursive: true, force: true });

            try {
                fs.renameSync(stagingDirectory, cacheDirectory);
            } catch (error) {
                if (!isValidCache(cacheDirectory, cachedWit, lockDigest, pin.commit, pin.subdirectory)) throw error;
            }
            return cachedWit;
        } finally {
            fs.rmSync(stagingDirectory, { recursive: true, force: true });
        }
    } catch (error) {
        throw new Error(
            `could not fetch Pumpkin WIT from ${pin.repository} at ${pin.commit} for ${lockFile}: ${errorMessage(error)}. The first build after a lock change needs Git and network access.`,
            { cause: error }
        );
    } finally {
        releaseLock();
    }
}

/**
 * Validate the lockfile fields described by the upstream Git pin schema.
 * @param {string} source Lockfile JSON text.
 * @param {string} lockFile Lockfile path for diagnostics.
 * @returns {{ repository: string, branch: string, commit: string, subdirectory: string }} The normalized pin.
 */
export function parsePumpkinWitPin(source, lockFile) {
    let value;
    try {
        value = JSON.parse(source);
    } catch (error) {
        throw new Error(`WIT lockfile is invalid JSON at ${lockFile}: ${errorMessage(error)}`, { cause: error });
    }

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`WIT lockfile must be a JSON object: ${lockFile}`);
    }
    const record = value;
    const allowedFields = new Set(['$schema', 'repository', 'branch', 'commit', 'subdirectory']);
    const unexpectedField = Object.keys(record).find((field) => !allowedFields.has(field));
    if (unexpectedField) throw new Error(`WIT lockfile has unsupported field ${unexpectedField}: ${lockFile}`);
    if (record.$schema !== upstreamGitPinSchema) {
        throw new Error(`WIT lockfile must use ${upstreamGitPinSchema} as its $schema: ${lockFile}`);
    }
    const repository = typeof record.repository === 'string' ? parseGitRepositoryUri(record.repository) : undefined;
    if (!repository) {
        throw new Error(`WIT lockfile must provide a valid HTTPS or file Git repository URI: ${lockFile}`);
    }
    if (typeof record.branch !== 'string' || !record.branch.trim()) {
        throw new Error(`WIT lockfile must provide a non-empty branch: ${lockFile}`);
    }
    if (typeof record.commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(record.commit)) {
        throw new Error(`WIT lockfile must provide a full 40- or 64-character commit SHA: ${lockFile}`);
    }
    if (typeof record.subdirectory !== 'string' || !isSafeSubdirectory(record.subdirectory)) {
        throw new Error(`WIT lockfile must provide a safe repository-relative subdirectory: ${lockFile}`);
    }

    return {
        repository,
        branch: record.branch,
        commit: record.commit.toLowerCase(),
        subdirectory: record.subdirectory
    };
}

function readLockSource(lockFile) {
    if (!fs.existsSync(lockFile)) throw new Error(`WIT lockfile not found: ${lockFile}`);
    return fs.readFileSync(lockFile, 'utf8');
}

function parseGitRepositoryUri(value) {
    try {
        const uri = new URL(value);
        if ((uri.protocol === 'https:' && !uri.username && !uri.password) || uri.protocol === 'file:') {
            // HTTPS/file only blocks Git helper transports that could invoke unexpected programs; normalize for Git.
            return uri.href;
        }
        return undefined;
    } catch {
        return undefined;
    }
}

function assertCacheRootIsExternal(cacheRoot) {
    const resolvedCacheRoot = path.resolve(cacheRoot);
    const realCacheRoot = resolveThroughExistingPath(resolvedCacheRoot);
    for (const candidate of new Set([resolvedCacheRoot, realCacheRoot])) {
        const segments = candidate
            .split(path.sep)
            .filter(Boolean)
            .map((segment) => segment.toLowerCase());
        const hasNodeModules = segments.includes('node_modules');
        const hasPnpmStore =
            segments.some((segment) => segment === '.pnpm-store' || segment === 'pnpm-store') ||
            segments.some((segment, index) => segment === 'pnpm' && segments[index + 1] === 'store');
        if (hasNodeModules || hasPnpmStore) {
            throw new Error(`Pumpkin WIT cache must stay outside node_modules and the pnpm store: ${cacheRoot}`);
        }
    }
}

function resolveThroughExistingPath(directory) {
    let existingPath = directory;
    while (!fs.existsSync(existingPath)) {
        const parent = path.dirname(existingPath);
        if (parent === existingPath) return directory;
        existingPath = parent;
    }
    return path.resolve(fs.realpathSync(existingPath), path.relative(existingPath, directory));
}

function isValidCache(cacheDirectory, witDirectory, lockDigest, commit, subdirectory) {
    const pinFile = path.join(cacheDirectory, 'pin.json');
    try {
        if (!fs.existsSync(pinFile) || !hasWitFiles(witDirectory)) return false;
        const cachedPin = JSON.parse(fs.readFileSync(pinFile, 'utf8'));
        return (
            cachedPin.lockDigest === lockDigest &&
            cachedPin.commit === commit &&
            cachedPin.subdirectory === subdirectory &&
            matchesWitFileManifest(cachedPin.witFiles, getWitFileManifest(witDirectory))
        );
    } catch {
        return false;
    }
}

function getWitFileManifest(directory) {
    const witFiles = [];

    function collect(currentDirectory) {
        for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true })) {
            const entryPath = path.join(currentDirectory, entry.name);
            if (entry.isDirectory()) {
                collect(entryPath);
            } else if (entry.isFile() && entry.name.endsWith('.wit')) {
                witFiles.push({
                    path: path.relative(directory, entryPath).split(path.sep).join('/'),
                    sha256: createHash('sha256').update(fs.readFileSync(entryPath)).digest('hex')
                });
            }
        }
    }

    collect(directory);
    return witFiles.sort(compareWitFilePaths);
}

function matchesWitFileManifest(manifest, actualWitFiles) {
    if (!Array.isArray(manifest) || manifest.length !== actualWitFiles.length) return false;

    const expectedWitFiles = [];
    for (const entry of manifest) {
        if (
            typeof entry !== 'object' ||
            entry === null ||
            typeof entry.path !== 'string' ||
            !isSafeSubdirectory(entry.path) ||
            typeof entry.sha256 !== 'string' ||
            !/^[a-f0-9]{64}$/.test(entry.sha256)
        ) {
            return false;
        }
        expectedWitFiles.push({ path: entry.path, sha256: entry.sha256 });
    }

    expectedWitFiles.sort(compareWitFilePaths);
    return actualWitFiles.every(
        (file, index) => file.path === expectedWitFiles[index].path && file.sha256 === expectedWitFiles[index].sha256
    );
}

function compareWitFilePaths(left, right) {
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function acquireCacheLock(cacheParent, cacheDirectory, cachedWit, lockDigest, commit, subdirectory) {
    const lockDirectory = path.join(cacheParent, `.${lockDigest}.lock`);
    const reclaimDirectory = `${lockDirectory}.reclaim`;
    const startedAt = Date.now();

    while (Date.now() - startedAt < maxLockWaitMs) {
        if (isValidCache(cacheDirectory, cachedWit, lockDigest, commit, subdirectory)) return undefined;

        try {
            fs.mkdirSync(lockDirectory);
            return createOwnedDirectoryLock(lockDirectory);
        } catch (error) {
            if (!isAlreadyExists(error)) throw error;
            if (isStaleLock(lockDirectory)) {
                const releaseReclaimClaim = tryCreateOwnedDirectoryLock(reclaimDirectory);
                if (releaseReclaimClaim) {
                    try {
                        if (isValidCache(cacheDirectory, cachedWit, lockDigest, commit, subdirectory)) return undefined;
                        if (!isStaleLock(lockDirectory)) continue;

                        fs.rmSync(lockDirectory, { recursive: true, force: true });
                        try {
                            fs.mkdirSync(lockDirectory);
                        } catch (createError) {
                            if (isAlreadyExists(createError)) continue;
                            throw createError;
                        }
                        return createOwnedDirectoryLock(lockDirectory);
                    } finally {
                        releaseReclaimClaim();
                    }
                }
            }
            Atomics.wait(lockWait, 0, 0, 100);
        }
    }

    throw new Error(
        `timed out waiting for the Pumpkin WIT cache lock: ${lockDirectory}; stale-lock recovery claim: ${reclaimDirectory}`
    );
}

function tryCreateOwnedDirectoryLock(lockDirectory) {
    try {
        fs.mkdirSync(lockDirectory);
    } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        if (!removeStaleOwnedDirectoryLock(lockDirectory)) return undefined;
        try {
            fs.mkdirSync(lockDirectory);
        } catch (createError) {
            if (isAlreadyExists(createError)) return undefined;
            throw createError;
        }
    }
    return createOwnedDirectoryLock(lockDirectory);
}

function removeStaleOwnedDirectoryLock(lockDirectory) {
    const identity = readDirectoryIdentity(lockDirectory);
    if (!identity) return true;

    const ownerFile = path.join(lockDirectory, 'owner.json');
    const ownerSource = readLockOwnerSource(ownerFile);
    if (!isStaleLock(lockDirectory)) return false;
    if (readDirectoryIdentity(lockDirectory) !== identity || readLockOwnerSource(ownerFile) !== ownerSource)
        return false;
    if (!isStaleLock(lockDirectory)) return false;

    fs.rmSync(lockDirectory, { recursive: true, force: true });
    return true;
}

function createOwnedDirectoryLock(lockDirectory) {
    const ownerFile = path.join(lockDirectory, 'owner.json');
    const token = randomUUID();
    const identity = readDirectoryIdentity(lockDirectory);

    try {
        fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token }));
    } catch (error) {
        removeDirectoryIfUnchanged(lockDirectory, identity);
        throw error;
    }

    return () => {
        if (readLockOwnerToken(ownerFile) === token) fs.rmSync(lockDirectory, { recursive: true, force: true });
    };
}

function readDirectoryIdentity(directory) {
    try {
        const { dev, ino } = fs.statSync(directory);
        return `${dev}:${ino}`;
    } catch {
        return undefined;
    }
}

function removeDirectoryIfUnchanged(directory, identity) {
    if (identity && readDirectoryIdentity(directory) === identity) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function readLockOwnerToken(ownerFile) {
    const contents = readLockOwnerSource(ownerFile);
    if (contents === undefined) return undefined;
    try {
        const owner = JSON.parse(contents);
        return typeof owner.token === 'string' ? owner.token : undefined;
    } catch {
        return undefined;
    }
}

function readLockOwnerSource(ownerFile) {
    try {
        return fs.readFileSync(ownerFile, 'utf8');
    } catch {
        return undefined;
    }
}

function isStaleLock(lockDirectory) {
    let owner;
    try {
        owner = JSON.parse(fs.readFileSync(path.join(lockDirectory, 'owner.json'), 'utf8'));
    } catch {
        try {
            return Date.now() - fs.statSync(lockDirectory).mtimeMs > staleLockAgeMs;
        } catch {
            return true;
        }
    }

    if (typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || owner.pid < 1) return true;
    try {
        process.kill(owner.pid, 0);
        return false;
    } catch (error) {
        return isNoSuchProcess(error);
    }
}

function isAlreadyExists(error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function isNoSuchProcess(error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}

function hasWitFiles(directory) {
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return false;
    return fs.readdirSync(directory, { withFileTypes: true }).some((entry) => {
        const entryPath = path.join(directory, entry.name);
        return entry.isDirectory() ? hasWitFiles(entryPath) : entry.isFile() && entry.name.endsWith('.wit');
    });
}

function isSafeSubdirectory(value) {
    // Reject traversal so lockfile paths stay inside the pinned checkout and cache.
    if (!value || value.startsWith('/') || value.includes('\\')) return false;
    return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function runGit(args) {
    return execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' }).trim();
}

function errorMessage(error) {
    return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
}
