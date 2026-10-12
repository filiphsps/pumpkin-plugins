import * as path from 'node:path';
import { type HermesFileSystem, type HermesProcessRunner, hermesFileSystem, hermesProcess } from './system.ts';

/** A numbered source patch and the paths it is allowed to modify. */
export interface HermesPatch {
    /** Patch filename within the configured series. */
    name: string;
    /** Absolute path to the patch file. */
    filename: string;
    /** Numeric prefix that determines application order. */
    sequence: number;
    /** Source paths listed in the patch headers. */
    affectedPaths: string[];
}

/** Inputs for validating and applying the configured Hermes patch series. */
export interface ApplyHermesPatchesOptions {
    /** Hermes source checkout to validate and patch. */
    source: string;
    /** Contiguous, numerically ordered patch series. */
    patches: readonly HermesPatch[];
    /** Optional source commit required before applying the patches. */
    expectedCommit?: string;
    /** Optional filesystem implementation for tests. */
    filesystem?: HermesFileSystem;
    /** Optional Git command runner for tests. */
    process?: HermesProcessRunner;
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
    filesystem: HermesFileSystem = hermesFileSystem
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
                `Hermes patch order must be contiguous; expected ${String(expected).padStart(4, '0')}, found ${patch.name}`
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

/**
 * Apply each unapplied patch in numeric order, rejecting unrelated source edits or conflicts.
 *
 * @param options - Source checkout, validated patch series, and optional commit and test dependencies.
 * @throws {Error} If the checkout has the wrong commit, unrelated edits, or a patch conflict.
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
    const states = options.patches.map((patch) => ({
        patch,
        applied: canApply(runner, options.source, patch.filename, true),
        applicable: canApply(runner, options.source, patch.filename, false)
    }));
    for (const { patch, applied, applicable } of states) {
        if (applied) continue;
        if (!applicable) {
            throw new Error(
                `Hermes patch does not apply to the pinned source (conflict or partial application): ${patch.filename}`
            );
        }
        runner.run('git', ['-C', options.source, 'apply', patch.filename]);
    }
}

/**
 * Confirm that every patch in the validated series is present before the build starts.
 *
 * @param source - Hermes source checkout to inspect.
 * @param patches - Validated patch series that must already be applied.
 * @param runner - Git command runner used to check each patch in reverse.
 * @throws {Error} If any patch is missing from the checkout.
 */
export function verifyHermesPatchSeriesApplied(
    source: string,
    patches: readonly HermesPatch[],
    runner: HermesProcessRunner = hermesProcess
): void {
    for (const patch of patches) {
        if (!canApply(runner, source, patch.filename, true)) {
            throw new Error(`Hermes patch is not applied: ${patch.filename}; run hermes patch first`);
        }
    }
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
    runner: HermesProcessRunner = hermesProcess
): void {
    const status = runner.output('git', ['-C', source, 'status', '--porcelain', '--untracked-files=all']);
    if (!status) return;
    const allowed = new Set(affectedHermesPaths(patches));
    const changed = status.split('\n').map((line) => line.slice(3).replace(/ -> .*/, ''));
    const unexpected = changed.filter((filename) => !allowed.has(filename));
    if (unexpected.length > 0) {
        throw new Error(
            `Hermes source has local changes outside the managed patch set: ${source} (${unexpected.join(', ')})`
        );
    }
}

function patchPaths(contents: string): string[] {
    return [...contents.matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?([^\t\r\n]+)$/gm)]
        .map((match) => match[1])
        .filter((filename): filename is string => filename !== undefined && filename !== '/dev/null');
}

function canApply(runner: HermesProcessRunner, source: string, patch: string, reverse: boolean): boolean {
    try {
        runner.run('git', ['-C', source, 'apply', '--check', ...(reverse ? ['--reverse'] : []), patch], {
            stdio: 'ignore'
        });
        return true;
    } catch {
        return false;
    }
}
