import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseHermesGitStatusPaths } from './git-status.ts';
import { type HermesFileSystem, type HermesProcessRunner, hermesFileSystem, hermesProcess } from './system.ts';

/** A numbered source patch and the paths it is allowed to modify. */
export interface HermesPatch {
    /** Source paths listed in the patch headers. */
    affectedPaths: string[];
    /** Absolute path to the patch file. */
    filename: string;
    /** Patch filename within the configured series. */
    name: string;
    /** Numeric prefix that determines application order. */
    sequence: number;
}

/** Inputs for validating and applying the configured Hermes patch series. */
export interface ApplyHermesPatchesOptions {
    /** Optional source commit required before applying the patches. */
    expectedCommit?: string;
    /** Optional filesystem implementation for tests. */
    filesystem?: HermesFileSystem;
    /** Contiguous, numerically ordered patch series. */
    patches: readonly HermesPatch[];
    /** Optional Git command runner for tests. */
    process?: HermesProcessRunner;
    /** Hermes source checkout to validate and patch. */
    source: string;
}

/**
 * Discover and validate the numbered Hermes patch series without applying it.
 *
 * @param patchesDirectory - Directory containing four-digit-prefixed `.patch` files.
 * @param filesystem - Filesystem implementation used to enumerate and read patches.
 * @returns Patches sorted by their contiguous numeric sequence, with affected paths extracted.
 * @throws {Error} If no patches exist, a sequence is duplicated, or the sequence has a gap.
 */
export function readHermesPatchSeries(
    patchesDirectory: string,
    filesystem: HermesFileSystem = hermesFileSystem,
): HermesPatch[] {
    const filenames = filesystem
        .readdirSync(patchesDirectory)
        .filter((filename) => /^\d{4}-.*\.patch$/.test(filename))
        .sort();
    if (filenames.length === 0) throw new Error(`No Hermes patches found in ${patchesDirectory}`);
    const seen = new Set<number>();
    const patches = filenames.map((name): HermesPatch => {
        const sequence = Number(name.slice(0, 4));
        if (seen.has(sequence)) throw new Error(`Duplicate Hermes patch sequence ${String(sequence).padStart(4, '0')}`);
        seen.add(sequence);
        const filename = path.join(patchesDirectory, name);
        return { name, filename, sequence, affectedPaths: patchPaths(filesystem.readFileSync(filename, 'utf8')) };
    });
    patches.forEach((patch, index) => {
        const expected = index + 1;
        if (patch.sequence !== expected) {
            throw new Error(
                `Hermes patch order must be contiguous; expected ${String(expected).padStart(4, '0')}, found ${patch.name}`,
            );
        }
    });
    return patches;
}

/**
 * Return unique source paths modified by a validated patch series.
 *
 * @param patches - Patches whose affected paths should be combined.
 * @returns Each managed source path once, preserving first-seen order.
 */
export function affectedHermesPaths(patches: readonly HermesPatch[]): string[] {
    return [...new Set(patches.flatMap(({ affectedPaths }) => affectedPaths))];
}

/** Raised when the checkout matches no prefix of the patch series, or a patch does not apply in sequence. */
export class HermesPatchConflictError extends Error {
    /** Absolute path of the first patch that could not be applied. */
    readonly patch: string;

    constructor(patch: string) {
        super(`Hermes patch does not apply to the pinned source (conflict or partial application): ${patch}`);
        this.name = 'HermesPatchConflictError';
        this.patch = patch;
    }
}

/**
 * Apply each unapplied patch in numeric order, rejecting unrelated source edits or conflicts.
 *
 * @remarks
 * Patches are checked in sequence, so a patch may depend on context added by an earlier one. A checkout that already
 * holds the first few patches gets only the rest.
 *
 * @param options - Source checkout, validated patch series, and optional commit and test dependencies.
 * @throws {HermesPatchConflictError} If the managed files match no applied prefix or a patch does not apply.
 * @throws {Error} If the checkout has the wrong commit or unrelated edits.
 */
export function applyHermesPatchSeries(options: ApplyHermesPatchesOptions): void {
    const runner = options.process ?? hermesProcess;
    if (options.expectedCommit) {
        const actualCommit = runner.output('git', ['-C', options.source, 'rev-parse', 'HEAD']);
        if (actualCommit !== options.expectedCommit) {
            throw new Error(`Hermes patch source is ${actualCommit}, expected pinned commit ${options.expectedCommit}`);
        }
    }
    ensurePatchOnlyChanges(options.source, options.patches, runner);
    const filesystem = options.filesystem ?? hermesFileSystem;
    const contents = options.patches.map((patch) => readPatchContents(filesystem, patch.filename));
    const applied = appliedPatchCount(options.source, options.patches, contents, runner);
    if (applied < 0) throw new HermesPatchConflictError(options.patches[0]?.filename ?? options.source);
    options.patches.slice(applied).forEach((patch, index) => {
        try {
            runner.run('git', ['-C', options.source, 'apply'], { input: contents[applied + index], stdio: 'pipe' });
        } catch {
            throw new HermesPatchConflictError(patch.filename);
        }
    });
}

/**
 * Confirm that every patch in the validated series is present before the build starts.
 *
 * @param source - Hermes source checkout to inspect.
 * @param patches - Validated patch series that must already be applied.
 * @param runner - Git command runner used to replay the series on a temporary index.
 * @param filesystem - File system used to read patch contents.
 * @throws {Error} If any patch is missing from the checkout.
 */
export function verifyHermesPatchSeriesApplied(
    source: string,
    patches: readonly HermesPatch[],
    runner: HermesProcessRunner = hermesProcess,
    filesystem: HermesFileSystem = hermesFileSystem,
): void {
    const contents = patches.map((patch) => readPatchContents(filesystem, patch.filename));
    const applied = appliedPatchCount(source, patches, contents, runner);
    const missing = patches[Math.max(applied, 0)];
    if (missing) throw new Error(`Hermes patch is not applied: ${missing.filename}; run hermes patch first`);
}

/**
 * Ensure current checkout edits touch only files owned by the configured patch series.
 *
 * @param source - Hermes source checkout to inspect.
 * @param patches - Validated patch series defining the allowed paths.
 * @param runner - Git command runner used to read the checkout status.
 * @throws {Error} If an edited or untracked file is outside the patch-owned paths.
 */
export function ensurePatchOnlyChanges(
    source: string,
    patches: readonly HermesPatch[],
    runner: HermesProcessRunner = hermesProcess,
): void {
    const status = runner.output('git', ['-C', source, 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (!status) return;
    const allowed = new Set(affectedHermesPaths(patches));
    const changed = parseHermesGitStatusPaths(status);
    const unexpected = changed.filter((filename) => !allowed.has(filename));
    if (unexpected.length > 0) {
        throw new Error(
            `Hermes source has local changes outside the managed patch set: ${source} (${unexpected.join(', ')})`,
        );
    }
}

function patchPaths(contents: string): string[] {
    return [...contents.matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?([^\t\r\n]+)$/gm)]
        .map((match) => match[1])
        .filter((filename): filename is string => filename !== undefined && filename !== '/dev/null');
}

/**
 * Count how many leading patches the checkout holds by replaying the series on a temporary index.
 *
 * The index starts at HEAD and takes one patch at a time. After each step the managed files in the working tree are
 * compared with it, so overlapping patches are checked in the same order they are applied.
 *
 * @returns The length of the longest matching prefix, or -1 when the managed files match none.
 */
function appliedPatchCount(
    source: string,
    patches: readonly HermesPatch[],
    contents: readonly string[],
    runner: HermesProcessRunner,
): number {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-patch-index-'));
    const env = { ...process.env, GIT_INDEX_FILE: path.join(directory, 'index') };
    const paths = affectedHermesPaths(patches);
    const git = (args: string[], input?: string): string =>
        runner.output('git', ['-C', source, ...args], { env, input, stdio: 'pipe' });
    const matches = (): boolean => {
        try {
            git(['diff', '--quiet', '--', ...paths]);
        } catch {
            return false;
        }
        return git(['ls-files', '-z', '--others', '--', ...paths]) === '';
    };
    try {
        git(['read-tree', 'HEAD']);
        let applied = matches() ? 0 : -1;
        for (const [index, patch] of contents.entries()) {
            try {
                git(['apply', '--cached'], patch);
            } catch {
                break;
            }
            if (matches()) applied = index + 1;
        }
        return applied;
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

/** Read patch text and normalize its line endings before sending it to Git. */
function readPatchContents(filesystem: HermesFileSystem, filename: string): string {
    return filesystem.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n');
}
