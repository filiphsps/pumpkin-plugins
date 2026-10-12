import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BuildError } from './errors.ts';

/** The WASI WIT files a build needs, pinned by content hash. */
export interface WasiWitLock {
    /** WASI release the files come from. */
    version: string;
    /** SHA-256 of each WIT file, by path below the cache directory. */
    files: Record<string, string>;
    /** Alternate pinned source URLs for WIT files outside the wasi repository. */
    sources?: Record<string, string>;
    /** Contents for pinned WIT files that have no upstream source file. */
    generatedFiles?: Record<string, string>;
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
 * Makes the WASI WIT files available locally. Files already cached with the right hash are kept;
 * missing or damaged upstream files are downloaded and generated files are materialized from the
 * lock. Every file is checked against its hash before it is written. Nothing is downloaded when the
 * cache is complete.
 * @param options - Where to cache and, for tests, what to download with.
 * @returns The folder holding `<package>/<interface>.wit`.
 * @throws {BuildError} When a file can't be downloaded or doesn't match its pinned hash.
 */
export async function ensureWasiWit(options: WasiWitOptions): Promise<string> {
    const lock = options.lock ?? readLock();
    const fetchFile = options.fetchFile ?? defaultFetch;
    const dir = path.join(options.cacheDir, 'wasi-wit', lock.version);
    const generatedFiles = lock.generatedFiles ?? {};

    for (const rel of Object.keys(generatedFiles)) {
        if (!Object.hasOwn(lock.files, rel)) {
            throw new BuildError(`generated WIT file ${rel} is missing from the files lock`);
        }
    }

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
                        `could not download ${url} (${err instanceof Error ? err.message : err}). The first build needs network access; the files are cached in ${dir} afterwards.`
                    );
                }
            }
            const actual = sha256(bytes);
            if (actual !== hash) {
                const source = generated === undefined ? (lock.sources?.[rel] ?? `WASI v${lock.version}`) : 'the lock';
                throw new BuildError(`${rel} from ${source} has hash ${actual}, expected ${hash}`);
            }
            writeAtomically(path.join(dir, rel), bytes, options.cacheDir);
        })
    );
    return dir;
}

function writeAtomically(file: string, bytes: Uint8Array, stagingDirectory: string): void {
    const parent = path.dirname(file);
    fs.mkdirSync(parent, { recursive: true });
    // Keep staging outside the shared WIT tree: concurrent builds copy that tree into jco's
    // input directory, and must not observe a temporary directory while it is being removed.
    fs.mkdirSync(stagingDirectory, { recursive: true });
    const temporaryDirectory = fs.mkdtempSync(path.join(stagingDirectory, '.wasi-wit-'));
    const temporary = path.join(temporaryDirectory, path.basename(file));
    try {
        fs.writeFileSync(temporary, bytes);
        fs.renameSync(temporary, file);
    } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
}
