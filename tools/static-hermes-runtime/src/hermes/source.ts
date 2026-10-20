import * as path from 'node:path';
import { parseHermesGitStatusPaths } from './git-status.ts';
import { type HermesFileSystem, type HermesProcessRunner, hermesFileSystem, hermesProcess } from './system.ts';

/** Repository, branch, and commit that identify the pinned Hermes source. */
export interface HermesSourcePin {
    /** Pinned upstream branch name recorded with the commit. */
    branch: string;
    /** Exact 40-character commit SHA used for checkout and build validation. */
    commit: string;
    /** Public HTTPS Git repository URL. */
    repository: string;
}

/** Source paths and injectable filesystem/process dependencies for Hermes checkout management. */
export interface EnsureHermesSourceOptions {
    /** Optional filesystem implementation for tests. */
    filesystem?: HermesFileSystem;
    /** Paths that the configured patch series is allowed to modify. */
    managedPaths: readonly string[];
    /** Whether this path is managed by the runtime's shared cache and can be rebuilt. */
    managedSource: boolean;
    /** Validated repository and commit to check out. */
    pin: HermesSourcePin;
    /** Optional Git command runner for tests. */
    process?: HermesProcessRunner;
    /** Hermes source checkout path. */
    source: string;
}

/**
 * Validate the JSON source pin before its repository or revision reaches a command invocation.
 *
 * @param value - Parsed JSON value from the source pin file.
 * @returns A normalized pin with a lowercase commit SHA.
 * @throws {Error} If the repository is not a public HTTPS URL or the branch or commit is invalid.
 */
export function parseHermesSourcePin(value: unknown): HermesSourcePin {
    if (typeof value !== 'object' || value === null) throw new Error('Hermes source pin must be a JSON object');
    const record = value as Record<string, unknown>;
    if (typeof record.repository !== 'string') throw new Error('Hermes source pin must provide repository');
    let repository: URL;
    try {
        repository = new URL(record.repository);
    } catch {
        throw new Error(`Hermes source pin has an invalid repository URL: ${String(record.repository)}`);
    }
    if (repository.protocol !== 'https:' || repository.username || repository.password) {
        throw new Error('Hermes source repository must be a public HTTPS URL');
    }
    if (typeof record.branch !== 'string' || !record.branch.trim()) {
        throw new Error('Hermes source pin must provide a branch');
    }
    if (typeof record.commit !== 'string' || !/^[a-f0-9]{40}$/i.test(record.commit)) {
        throw new Error('Hermes source pin must provide a 40-character commit SHA');
    }
    return { repository: record.repository, branch: record.branch, commit: record.commit.toLowerCase() };
}

/**
 * Read and validate the repository-owned Hermes source pin.
 *
 * @param filename - Path to the JSON source pin.
 * @param filesystem - Filesystem implementation used to read the pin.
 * @returns The normalized source pin.
 */
export function readHermesSourcePin(
    filename: string,
    filesystem: HermesFileSystem = hermesFileSystem,
): HermesSourcePin {
    if (!filesystem.existsSync(filename)) throw new Error(`Hermes source pin not found at ${filename}`);
    let value: unknown;
    try {
        value = JSON.parse(filesystem.readFileSync(filename, 'utf8')) as unknown;
    } catch (error) {
        throw new Error(
            `Hermes source pin is invalid JSON at ${filename}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    return parseHermesSourcePin(value);
}

/**
 * Ensure that the configured source directory is a checkout at the pinned Hermes commit.
 *
 * @param options - Pin, checkout path, ownership state, and permitted patch paths.
 * @returns The verified Hermes source path.
 * @throws {Error} If the checkout is invalid, has unexpected local changes, or a custom path has the wrong commit.
 */
export function ensureHermesSource(options: EnsureHermesSourceOptions): string {
    const filesystem = options.filesystem ?? hermesFileSystem;
    const process = options.process ?? hermesProcess;
    if (!filesystem.existsSync(options.source)) installPinnedSource(options, filesystem, process);
    if (!hasGitDirectory(options.source, process)) {
        throw new Error(`Hermes source path is not a Git checkout: ${options.source}`);
    }
    const actualCommit = process.output('git', ['-C', options.source, 'rev-parse', 'HEAD']);
    if (actualCommit === options.pin.commit) {
        verifyManagedChanges(options.source, options.managedPaths, process);
        return options.source;
    }
    if (!options.managedSource) {
        throw new Error(
            `Hermes source is ${actualCommit}, expected pinned commit ${options.pin.commit}: ${options.source}`,
        );
    }
    verifyManagedChanges(options.source, options.managedPaths, process);
    rebuildPinnedSource(options, filesystem, process);
    return options.source;
}

/**
 * Replace a checkout whose changed files belong to this patch series with the pinned clean source.
 *
 * @param options - Pin, checkout path, and the paths owned by the configured patch series.
 * @returns The refreshed Hermes source path.
 * @throws {Error} If the checkout is a custom source path, is not at the pinned commit, or contains
 * changes outside managed paths.
 */
export function refreshHermesSource(options: EnsureHermesSourceOptions): string {
    if (!options.managedSource) {
        throw new Error(
            `The patch series conflicts with the custom Hermes source at ${options.source}; reset it to the pinned commit ${options.pin.commit} and run again`,
        );
    }
    const filesystem = options.filesystem ?? hermesFileSystem;
    const process = options.process ?? hermesProcess;
    if (!hasGitDirectory(options.source, process)) {
        throw new Error(`Hermes source path is not a Git checkout: ${options.source}`);
    }
    const actualCommit = process.output('git', ['-C', options.source, 'rev-parse', 'HEAD']);
    if (actualCommit !== options.pin.commit) {
        throw new Error(
            `Hermes source is ${actualCommit}, expected pinned commit ${options.pin.commit}: ${options.source}`,
        );
    }
    verifyManagedChanges(options.source, options.managedPaths, process);
    rebuildPinnedSource(options, filesystem, process);
    return options.source;
}

/** Clone and check out the validated Hermes commit into a destination directory. */
function clonePinnedSource(
    pin: HermesSourcePin,
    destination: string,
    filesystem: HermesFileSystem,
    process: HermesProcessRunner,
): void {
    filesystem.mkdirSync(path.dirname(destination), { recursive: true });
    process.run('git', ['clone', '--filter=blob:none', '--no-checkout', pin.repository, destination]);
    process.run('git', ['-C', destination, 'config', 'core.autocrlf', 'false']);
    process.run('git', ['-C', destination, 'fetch', '--depth', '1', 'origin', pin.commit]);
    process.run('git', ['-C', destination, 'checkout', '--detach', pin.commit]);
}

/** Clone a first checkout beside its destination, then move it into place after Git succeeds. */
function installPinnedSource(
    options: EnsureHermesSourceOptions,
    filesystem: HermesFileSystem,
    runner: HermesProcessRunner,
): void {
    const installing = `${options.source}.install-${process.pid}-${Date.now()}`;
    try {
        clonePinnedSource(options.pin, installing, filesystem, runner);
        filesystem.renameSync(installing, options.source);
    } catch (error) {
        filesystem.rmSync(installing, { recursive: true, force: true });
        throw error;
    }
}

function rebuildPinnedSource(
    options: EnsureHermesSourceOptions,
    filesystem: HermesFileSystem,
    runner: HermesProcessRunner,
): void {
    const rebuilding = `${options.source}.rebuild-${process.pid}-${Date.now()}`;
    const previous = `${options.source}.stale-${process.pid}-${Date.now()}`;
    try {
        clonePinnedSource(options.pin, rebuilding, filesystem, runner);
    } catch (error) {
        filesystem.rmSync(rebuilding, { recursive: true, force: true });
        throw error;
    }
    filesystem.renameSync(options.source, previous);
    try {
        filesystem.renameSync(rebuilding, options.source);
    } catch (error) {
        filesystem.renameSync(previous, options.source);
        filesystem.rmSync(rebuilding, { recursive: true, force: true });
        throw error;
    }
    try {
        filesystem.rmSync(previous, { recursive: true, force: true });
    } catch (error) {
        console.warn(`Could not remove stale Hermes source cache at ${previous}: ${errorMessage(error)}`);
    }
    console.log('Rebuilt stale Hermes source cache from the pinned commit.');
}

function verifyManagedChanges(source: string, managedPaths: readonly string[], process: HermesProcessRunner): void {
    const status = process.output('git', ['-C', source, 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (!status) return;
    const allowed = new Set(managedPaths);
    const changedPaths = parseHermesGitStatusPaths(status);
    const unexpected = changedPaths.filter((filename) => !allowed.has(filename));
    if (unexpected.length > 0) {
        throw new Error(
            `Hermes source has local changes outside the managed patch set: ${source} (${unexpected.join(', ')})`,
        );
    }
}

function hasGitDirectory(directory: string, process: HermesProcessRunner): boolean {
    try {
        process.output('git', ['-C', directory, 'rev-parse', '--git-dir']);
        return true;
    } catch {
        return false;
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
