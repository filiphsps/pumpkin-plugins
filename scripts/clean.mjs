#!/usr/bin/env node
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PROJECT_FOLDERS = ['packages', 'tools'];
const BASE_DIRS = [
    // Gets matched in root and the folders defined in `PROJECT_FOLDERS`
    '.turbo/cache',
    'build',
    'coverage',
    'dist'
];

/** Remove generated build outputs and the Turbo task cache from a workspace. */
export function cleanWorkspace(root = workspaceRoot) {
    const directories = BASE_DIRS.map((path) => join(root, path));

    for (const workspaceGroup of PROJECT_FOLDERS) {
        const groupRoot = join(root, workspaceGroup);
        if (!existsSync(groupRoot)) continue;

        for (const entry of readdirSync(groupRoot, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;

            const dirs = BASE_DIRS.map((path) => join(groupRoot, entry.name, path));
            directories.push(...dirs);
        }
    }

    const filteredDirectories = directories.filter(
        (item) => !item.includes(join(root, '.cache')) && item.includes(root)
    );
    for (const directory of filteredDirectories) rmSync(directory, { recursive: true, force: true });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    cleanWorkspace();
}
