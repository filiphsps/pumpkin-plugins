// Compares workspace configuration between two revisions for scripts/changed-areas.mjs: the pnpm
// lockfile's importer entries and the workspace settings outside its catalogs.
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

/** Reads a tracked file at a revision, returning undefined when that revision has no such file. */
export function readGitFile(root, revision, file) {
    const result = spawnSync('git', ['show', `${revision}:${file}`], {
        cwd: root,
        encoding: 'utf8',
    });
    if (result.status === 0) return result.stdout;
    return undefined;
}

/** Reads each workspace importer block from a pnpm lockfile. */
function lockfileImporters(contents) {
    const importers = new Map();
    let inImporters = false;
    let currentImporter;
    for (const line of contents.split('\n')) {
        if (!inImporters) {
            if (line === 'importers:') inImporters = true;
            continue;
        }
        if (line && !line.startsWith(' ')) {
            inImporters = false;
            currentImporter = undefined;
            continue;
        }
        const entry = line.match(/^ {2}([^ ].*?):(?:\s*(.*))?$/);
        if (entry) {
            currentImporter = entry[1].replace(/^['"]|['"]$/g, '');
            importers.set(currentImporter, [line]);
        } else if (currentImporter) {
            importers.get(currentImporter).push(line);
        }
    }
    return new Map([...importers].map(([key, lines]) => [key, lines.join('\n')]));
}

/**
 * Returns the importer directories whose lockfile entries changed between two revisions, or
 * undefined when either revision has no lockfile.
 */
export function changedLockfileImporters(root, base, head) {
    const before = readGitFile(root, base, 'pnpm-lock.yaml');
    const after = readGitFile(root, head, 'pnpm-lock.yaml');
    if (before === undefined || after === undefined) return undefined;
    const previousImporters = lockfileImporters(before);
    const currentImporters = lockfileImporters(after);
    const changedImporters = new Set([...previousImporters.keys(), ...currentImporters.keys()]);
    return [...changedImporters]
        .filter((importer) => previousImporters.get(importer) !== currentImporters.get(importer))
        .map((importer) => (importer === '.' ? importer : path.posix.normalize(importer)));
}

/** Returns workspace configuration with catalog entries removed. */
function workspaceLayout(contents) {
    let insideCatalogs = false;
    const retainedLines = [];
    for (const line of contents.split('\n')) {
        if (/^catalogs?:\s*$/.test(line)) {
            insideCatalogs = true;
            continue;
        }
        if (insideCatalogs && line && !line.startsWith(' ')) insideCatalogs = false;
        if (!insideCatalogs) retainedLines.push(line);
    }
    return retainedLines.join('\n').trim();
}

/** Checks whether workspace configuration changed outside its catalogs between two revisions. */
export function workspaceLayoutChanged(root, base, head) {
    const before = readGitFile(root, base, 'pnpm-workspace.yaml');
    const after = readGitFile(root, head, 'pnpm-workspace.yaml');
    return before === undefined || after === undefined || workspaceLayout(before) !== workspaceLayout(after);
}
