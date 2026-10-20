// Reads the commit log that scripts/changed-areas.mjs classifies a change by.
import { ignoredCommitShas } from './ignored-commits.mjs';

/** The `git log` arguments, before the revision range, whose output parseCommitLog reads. */
export const COMMIT_LOG_ARGS = [
    'log',
    '--format=%H%x09%s',
    '--name-only',
    '--no-renames',
    '--diff-merges=first-parent',
];

/**
 * Parses a commit log written with COMMIT_LOG_ARGS.
 *
 * @returns Every commit's subject in log order, with whether `.git-blame-ignore-revs` lists the
 *     commit, and the files changed by the commits it doesn't list.
 */
export function parseCommitLog(log) {
    const commits = [];
    const files = new Set();
    let current;
    for (const line of log.split('\n')) {
        const separator = line.indexOf('\t');
        if (separator !== -1 && /^[a-f\d]{40}$/.test(line.slice(0, separator))) {
            current = { subject: line.slice(separator + 1), ignored: ignoredCommitShas.has(line.slice(0, separator)) };
            commits.push(current);
            continue;
        }
        if (current && !current.ignored && line) files.add(line);
    }
    return { commits, files };
}
