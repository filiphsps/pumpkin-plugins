import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WASI_VERSION } from '@pumpkin-plugins/wasi-capabilities';
import { BuildError } from './errors.ts';

/** The WASI WIT files a build needs, pinned by content hash. */
export interface WasiWitLock {
    /** SHA-256 of each WIT file, by path below the cache directory. */
    files: Record<string, string>;
    /** Contents for pinned WIT files that have no upstream source file. */
    generatedFiles?: Record<string, string>;
    /** Alternate pinned source URLs for WIT files outside the wasi repository. */
    sources?: Record<string, string>;
    /** WASI release the files come from. */
    version: string;
}
/** Downloads a URL. */
export type Fetcher = (url: string) => Promise<Uint8Array>;

/** Inputs to `ensureWasiWit`. */
export interface WasiWitOptions {
    /** Folder to cache under. The files go in `<cacheDir>/wasi-wit/<version>`. */
    cacheDir: string;
    /** Downloads a URL. Defaults to `fetch`. */
    fetchFile?: Fetcher;
    /** Validated WASI version and pinned relative file paths. Defaults to `wasi-wit.lock.json` next to the sources. */
    lock?: WasiWitLock;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeWitPath(file: string): boolean {
    if (
        !file.endsWith('.wit') ||
        file.includes('\\') ||
        file.includes(':') ||
        file.includes('\0') ||
        path.posix.isAbsolute(file) ||
        path.win32.isAbsolute(file)
    ) {
        return false;
    }

    return file.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function assertWitLockEntries(
    kind: 'file' | 'source' | 'generated-file',
    entries: unknown,
): asserts entries is Record<string, string> {
    if (!isRecord(entries)) throw new BuildError(`WASI WIT lock ${kind} entries must be an object`);

    for (const [file, entry] of Object.entries(entries)) {
        if (!isSafeWitPath(file)) throw new BuildError(`unsafe WASI WIT ${kind} path: ${file}`);
        if (typeof entry !== 'string') throw new BuildError(`WASI WIT ${kind} entry ${file} must be a string`);
    }
}

function validateWasiWitLock(lock: WasiWitLock): void {
    if (!isRecord(lock)) throw new BuildError('WASI WIT lock must be an object');

    const version = lock.version;
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
        throw new BuildError('unsafe WASI WIT lock version; expected a numeric x.y.z release');
    }
    if (version !== WASI_VERSION) {
        throw new BuildError(
            `WASI version ${version} in tools/build/wasi-wit.lock.json does not match WASI_VERSION ${WASI_VERSION} in tools/wasi-capabilities/src/index.ts; plugin WIT imports use WASI_VERSION, so pin the lock to the same release`,
        );
    }

    const files = lock.files;
    assertWitLockEntries('file', files);
    for (const [file, hash] of Object.entries(files)) {
        if (!/^[0-9a-f]{64}$/.test(hash)) throw new BuildError(`WASI WIT file ${file} has an invalid SHA-256 hash`);
    }

    const sources = lock.sources;
    if (sources !== undefined) {
        assertWitLockEntries('source', sources);
        for (const file of Object.keys(sources)) {
            if (!Object.hasOwn(files, file))
                throw new BuildError(`WASI WIT source ${file} is missing from the files lock`);
        }
    }

    const generatedFiles = lock.generatedFiles;
    if (generatedFiles !== undefined) {
        assertWitLockEntries('generated-file', generatedFiles);
        for (const [file, contents] of Object.entries(generatedFiles)) {
            const expectedHash = files[file];
            if (!Object.hasOwn(files, file)) {
                throw new BuildError(`generated WIT file ${file} is missing from the files lock`);
            }
            if (sha256(new TextEncoder().encode(contents)) !== expectedHash) {
                throw new BuildError(`generated WIT file ${file} does not match its pinned SHA-256 hash`);
            }
        }
    }
}

const DOWNLOAD_TIMEOUT_MS = 30_000;

const defaultFetch: Fetcher = async (url) => {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
    } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
            throw new Error(`timed out after ${DOWNLOAD_TIMEOUT_MS / 1000} s`);
        }
        throw error;
    }
};

/**
 * Reads the committed lock file.
 * @returns The pinned WASI WIT files.
 */
export function readLock(): WasiWitLock {
    const lock = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../wasi-wit.lock.json'), 'utf8'));
    validateWasiWitLock(lock);
    return lock;
}

function isCached(file: string, expected: string): boolean {
    try {
        if (!fs.lstatSync(file).isFile()) return false;
        return sha256(fs.readFileSync(file)) === expected;
    } catch {
        return false;
    }
}

/**
 * Makes the WASI WIT files available locally. Files already cached with the right hash are kept;
 * missing or damaged upstream files are downloaded and generated files are materialized from the
 * lock. Every file is checked against its hash before it is written and published with a rename, so
 * concurrent builds never see a partial file. Nothing is downloaded when the cache is complete.
 * @param options - Cache location and optional lock contents or downloader.
 * @returns The folder holding `<package>/<interface>.wit`.
 * @throws {BuildError} When the lock is invalid, a file can't be downloaded, or content doesn't match its pinned hash.
 */
export async function ensureWasiWit(options: WasiWitOptions): Promise<string> {
    const lock = options.lock ?? readLock();
    validateWasiWitLock(lock);
    const fetchFile = options.fetchFile ?? defaultFetch;
    const dir = path.join(options.cacheDir, 'wasi-wit', lock.version);
    const generatedFiles = lock.generatedFiles ?? {};

    const missing = Object.entries(lock.files).filter(([rel, hash]) => !isCached(path.join(dir, rel), hash));
    await Promise.all(
        missing.map(async ([rel, hash]) => {
            let bytes: Uint8Array;
            const generated = generatedFiles[rel];
            if (generated !== undefined) {
                bytes = new TextEncoder().encode(generated);
            } else {
                const url =
                    lock.sources?.[rel] ??
                    `https://raw.githubusercontent.com/WebAssembly/WASI/v${lock.version}/wasip2/${rel}`;
                try {
                    bytes = await fetchFile(url);
                } catch (err) {
                    throw new BuildError(
                        `could not download ${url} (${err instanceof Error ? err.message : err}). The first build needs network access; the files are cached in ${dir} afterwards.`,
                    );
                }
            }
            const actual = sha256(bytes);
            if (actual !== hash) {
                const source = generated === undefined ? (lock.sources?.[rel] ?? `WASI v${lock.version}`) : 'the lock';
                throw new BuildError(`${rel} from ${source} has hash ${actual}, expected ${hash}`);
            }
            writeAtomically(path.join(dir, rel), bytes, hash, options.cacheDir);
        }),
    );
    return dir;
}

// A rename onto a path that holds a file is atomic on POSIX. Windows refuses it with EEXIST or EPERM,
// and no platform renames a file onto a directory.
const RENAME_REFUSED = new Set(['EEXIST', 'EPERM', 'EISDIR', 'ENOTEMPTY']);

function writeAtomically(file: string, bytes: Uint8Array, expectedHash: string, stagingDirectory: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Keep staging outside the shared WIT tree: concurrent builds copy that tree into jco's
    // input directory, and must not observe a temporary directory while it is being removed.
    fs.mkdirSync(stagingDirectory, { recursive: true });
    const temporaryDirectory = fs.mkdtempSync(path.join(stagingDirectory, '.wasi-wit-'));
    const temporary = path.join(temporaryDirectory, path.basename(file));
    try {
        fs.writeFileSync(temporary, bytes);
        for (let attempt = 0; ; attempt += 1) {
            try {
                fs.renameSync(temporary, file);
                return;
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === undefined || !RENAME_REFUSED.has(code)) throw error;
                // Another build may have published the same pinned bytes first.
                if (isCached(file, expectedHash)) return;
                if (attempt === 1) throw error;
                fs.rmSync(file, { recursive: true, force: true });
            }
        }
    } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
}
