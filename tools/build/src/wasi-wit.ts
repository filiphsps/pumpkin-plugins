import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BuildError } from './errors.ts';

/** The WASI WIT files a build needs, pinned by content hash. */
export interface WasiWitLock {
    /** WASI release the files come from. */
    version: string;
    /** SHA-256 of each file, by path below `wasip2/`. */
    files: Record<string, string>;
}

/** Downloads a URL. */
export type Fetcher = (url: string) => Promise<Uint8Array>;

/** Inputs to `ensureWasiWit`. */
export interface WasiWitOptions {
    /** Folder to cache under. The files go in `<cacheDir>/wasi-wit/<version>`. */
    cacheDir: string;
    /** The pinned files. Defaults to `wasi-wit.lock.json` next to the sources. */
    lock?: WasiWitLock;
    /** Downloads a URL. Defaults to `fetch`. */
    fetchFile?: Fetcher;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const defaultFetch: Fetcher = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
};

/**
 * Reads the committed lock file.
 * @returns The pinned WASI WIT files.
 */
export function readLock(): WasiWitLock {
    return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../wasi-wit.lock.json'), 'utf8'));
}

function isCached(file: string, expected: string): boolean {
    return fs.existsSync(file) && sha256(fs.readFileSync(file)) === expected;
}

/**
 * Makes the WASI WIT files available locally. Files already cached with the right hash are kept,
 * missing or damaged ones are downloaded from the WASI repository and checked against the lock
 * before they are written. Nothing is downloaded when the cache is complete.
 * @param options - Where to cache and, for tests, what to download with.
 * @returns The folder holding `<package>/<interface>.wit`.
 * @throws {BuildError} When a file can't be downloaded or doesn't match its pinned hash.
 */
export async function ensureWasiWit(options: WasiWitOptions): Promise<string> {
    const lock = options.lock ?? readLock();
    const fetchFile = options.fetchFile ?? defaultFetch;
    const dir = path.join(options.cacheDir, 'wasi-wit', lock.version);

    const missing = Object.entries(lock.files).filter(([rel, hash]) => !isCached(path.join(dir, rel), hash));
    await Promise.all(
        missing.map(async ([rel, hash]) => {
            const url = `https://raw.githubusercontent.com/WebAssembly/WASI/v${lock.version}/wasip2/${rel}`;
            let bytes: Uint8Array;
            try {
                bytes = await fetchFile(url);
            } catch (err) {
                throw new BuildError(
                    `could not download ${url} (${err instanceof Error ? err.message : err}). The first build needs network access; the files are cached in ${dir} afterwards.`
                );
            }
            const actual = sha256(bytes);
            if (actual !== hash) throw new BuildError(`${rel} from ${url} has hash ${actual}, expected ${hash}`);
            writeAtomically(path.join(dir, rel), bytes);
        })
    );
    return dir;
}

function writeAtomically(file: string, bytes: Uint8Array): void {
    const parent = path.dirname(file);
    fs.mkdirSync(parent, { recursive: true });
    const temporaryDirectory = fs.mkdtempSync(path.join(parent, '.wasi-wit-'));
    const temporary = path.join(temporaryDirectory, path.basename(file));
    try {
        fs.writeFileSync(temporary, bytes);
        fs.renameSync(temporary, file);
    } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
}
