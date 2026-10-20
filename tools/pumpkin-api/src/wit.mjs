import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const upstreamGitPinSchema =
    'https://raw.githubusercontent.com/filiphsps/pumpkin-plugins/master/tools/pumpkin-api/schemas/upstream-git-pin.schema.json';

/**
 * Fetch the pinned Pumpkin WIT subdirectory on first use and when its lockfile changes.
 *
 * The cache directory is keyed by the SHA-256 digest of the complete lockfile, so a change to
 * any lock field cannot reuse files from another pin. WIT is copied out of the temporary Git
 * checkout and the checkout is removed before the cache is published. Cached WIT files are
 * verified against their SHA-256 manifest before reuse, so a modified cache cannot change API bindings.
 *
 * @param options - Lockfile path and consumer-owned cache root.
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
    const isCached = () => isValidCache(cacheDirectory, cachedWit, lockDigest, pin.commit, pin.subdirectory);
    if (isCached()) return cachedWit;

    fs.mkdirSync(cacheParent, { recursive: true });
    const stagingDirectory = fs.mkdtempSync(path.join(cacheParent, '.staging-'));

    try {
        const checkout = path.join(stagingDirectory, 'checkout');
        // Fetch only the pinned commit and only the blobs under the WIT subdirectory. End option
        // parsing so a validated remote cannot be interpreted as a Git option.
        runGit(['init', '--quiet', checkout]);
        runGit([
            '-C',
            checkout,
            'fetch',
            '--quiet',
            '--depth',
            '1',
            '--filter=blob:none',
            '--',
            pin.repository,
            pin.commit,
        ]);

        const fetchedCommit = runGit(['-C', checkout, 'rev-parse', 'FETCH_HEAD']).toLowerCase();
        if (fetchedCommit !== pin.commit) {
            throw new Error(`Git fetched ${fetchedCommit}, expected ${pin.commit}`);
        }
        const missingWit = new Error(
            `upstream commit ${pin.commit} does not contain WIT files under ${pin.subdirectory}/`,
        );
        if (!runGit(['-C', checkout, 'ls-tree', '--name-only', 'FETCH_HEAD', '--', pin.subdirectory])) throw missingWit;
        runGit(['-C', checkout, 'checkout', '--quiet', 'FETCH_HEAD', '--', pin.subdirectory]);

        const sourceWit = path.join(checkout, pin.subdirectory);
        if (!hasWitFiles(sourceWit)) throw missingWit;

        const stagedWit = path.join(stagingDirectory, pin.subdirectory);
        fs.mkdirSync(path.dirname(stagedWit), { recursive: true });
        fs.cpSync(sourceWit, stagedWit, { recursive: true });
        fs.writeFileSync(
            path.join(stagingDirectory, 'pin.json'),
            `${JSON.stringify({ lockDigest, ...pin, witFiles: getWitFileManifest(stagedWit) }, null, 4)}\n`,
        );
        fs.rmSync(checkout, { recursive: true, force: true });
        publishCache(stagingDirectory, cacheDirectory, cacheParent, isCached);
        return cachedWit;
    } catch (error) {
        throw new Error(
            `could not fetch Pumpkin WIT from ${pin.repository} at ${pin.commit} for ${lockFile}: ${errorMessage(error)}. The first build after a lock change needs Git and network access.`,
            { cause: error },
        );
    } finally {
        fs.rmSync(stagingDirectory, { recursive: true, force: true });
    }
}

// Concurrent builds may fetch the same pin; the first rename wins and the others reuse its cache.
// An invalid cache is renamed aside before publishing, so no build deletes a directory in use.
function publishCache(stagingDirectory, cacheDirectory, cacheParent, isCached) {
    for (let attempt = 0; ; attempt++) {
        try {
            fs.renameSync(stagingDirectory, cacheDirectory);
            return;
        } catch (error) {
            if (!isExistingDirectory(error)) throw error;
            if (isCached()) return;
            if (attempt > 0) throw error;
        }

        const trash = path.join(cacheParent, `.trash-${randomUUID()}`);
        try {
            fs.renameSync(cacheDirectory, trash);
        } catch (error) {
            if (!isMissing(error)) throw error;
        }
        fs.rmSync(trash, { recursive: true, force: true });
    }
}

/**
 * Validate the lockfile fields described by the upstream Git pin schema.
 * @param source - Lockfile JSON text.
 * @param lockFile - Lockfile path for diagnostics.
 * @returns The normalized pin.
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
        subdirectory: record.subdirectory,
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

/**
 * Digest the WIT files under a package directory, including nested folders.
 *
 * Each file contributes its `/`-separated relative path and contents, in path order, so the digest
 * changes when a WIT file is added, removed, renamed or edited. Files without the `.wit` extension
 * are ignored. Compatibility matrices record this value as `sourceWitSha256`.
 *
 * @param directory - WIT package directory, such as the one returned by `ensurePumpkinWit`.
 * @returns The lowercase hexadecimal SHA-256 digest.
 */
export function digestWitDirectory(directory) {
    const hash = createHash('sha256');
    for (const file of listWitFiles(directory)) {
        hash.update(file);
        hash.update('\0');
        hash.update(fs.readFileSync(path.join(directory, file)));
        hash.update('\0');
    }
    return hash.digest('hex');
}

function getWitFileManifest(directory) {
    return listWitFiles(directory).map((file) => ({
        path: file,
        sha256: createHash('sha256')
            .update(fs.readFileSync(path.join(directory, file)))
            .digest('hex'),
    }));
}

function listWitFiles(directory) {
    const witFiles = [];

    function collect(currentDirectory) {
        for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true })) {
            const entryPath = path.join(currentDirectory, entry.name);
            if (entry.isDirectory()) {
                collect(entryPath);
            } else if (entry.isFile() && entry.name.endsWith('.wit')) {
                witFiles.push(path.relative(directory, entryPath).split(path.sep).join('/'));
            }
        }
    }

    collect(directory);
    return witFiles.sort();
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
        (file, index) => file.path === expectedWitFiles[index].path && file.sha256 === expectedWitFiles[index].sha256,
    );
}

function compareWitFilePaths(left, right) {
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function isExistingDirectory(error) {
    // POSIX reports EEXIST or ENOTEMPTY for a non-empty rename target; Windows reports EPERM.
    return hasErrorCode(error, 'EEXIST') || hasErrorCode(error, 'ENOTEMPTY') || hasErrorCode(error, 'EPERM');
}

function isMissing(error) {
    return hasErrorCode(error, 'ENOENT');
}

function hasErrorCode(error, code) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
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
