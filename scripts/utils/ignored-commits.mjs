import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve(import.meta.dirname, '../../.git-blame-ignore-revs');
const commits = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

if (commits.some((sha) => !/^[a-f\d]{40}$/.test(sha)) || new Set(commits).size !== commits.length) {
    throw new Error(`${file} must contain unique 40-character commit SHAs, one per line`);
}

/** Commit SHAs excluded from release history and CI changed-file classification. */
export const ignoredCommitShas = new Set(commits);
