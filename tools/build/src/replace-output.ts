import * as fs from 'node:fs';

/**
 * Replaces an existing file or directory with a staged one: moves the old output aside, renames the
 * staged output into its place, and moves the old output back if that rename fails.
 *
 * The caller checks that `target` exists and has the expected kind, and removes `aside` after a
 * successful replace.
 *
 * @param aside - A free path on the same file system that holds the old output during the swap.
 * @param restoreFailureMessage - Message of the error thrown when the old output cannot be moved back.
 * @param onRestoreFailure - Runs before that error is thrown, so the caller can keep `aside` for recovery.
 * @throws {AggregateError} When neither the staged nor the old output could be moved to `target`. It
 * holds the publish error and the restore error, and `aside` still holds the old output. A failed
 * publish whose restore succeeds rethrows the publish error unchanged.
 */
export function replaceOutput(
    staged: string,
    target: string,
    aside: string,
    restoreFailureMessage: string,
    onRestoreFailure?: () => void,
): void {
    fs.renameSync(target, aside);
    try {
        fs.renameSync(staged, target);
    } catch (publishError) {
        try {
            fs.renameSync(aside, target);
        } catch (restoreError) {
            onRestoreFailure?.();
            throw new AggregateError([publishError, restoreError], restoreFailureMessage);
        }
        throw publishError;
    }
}
