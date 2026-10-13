/** The repository location and immutable revision that provide the Pumpkin WIT package. */
export interface PumpkinWitPin {
    /** Git repository URI. */
    repository: string;
    /** Branch recorded with the pinned commit. */
    branch: string;
    /** Full SHA-1 or SHA-256 Git object ID. */
    commit: string;
    /** Repository-relative directory containing the selected WIT package. */
    subdirectory: string;
}

/** Inputs for resolving the API package's pinned WIT into a consumer cache. */
export interface EnsurePumpkinWitOptions {
    /** Path to the API package's `wit.lock.json`. */
    lockFile: string;
    /** Cache root outside the installed API package and `node_modules`. */
    cacheRoot: string;
}

/**
 * Fetches the lockfile-selected Pumpkin WIT package on first use and when its lockfile changes.
 *
 * @param options Lockfile path and consumer-owned cache root.
 * @returns The cached WIT package directory selected by the lockfile.
 * @throws {Error} If the lock is invalid, Git cannot fetch its commit, or the commit lacks WIT files.
 */
export function ensurePumpkinWit(options: EnsurePumpkinWitOptions): string;

/**
 * Validates and normalizes the lockfile fields described by the upstream Git pin schema.
 *
 * @param source Lockfile JSON text.
 * @param lockFile Lockfile path for diagnostics.
 * @returns The normalized upstream Git pin.
 */
export function parsePumpkinWitPin(source: string, lockFile: string): PumpkinWitPin;
