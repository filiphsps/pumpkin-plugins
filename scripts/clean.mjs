#!/usr/bin/env node
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// `pnpm clean` deletes node_modules before this script runs, so import the source by path.
import { discoverComponents } from '../tools/docs/src/discovery.ts';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PROJECT_FOLDERS = ['packages', 'tools', 'extensions', 'benchmarks'];
const BASE_DIRS = [
    // Gets matched in root and in every package found in the folders defined in `PROJECT_FOLDERS`
    '.turbo/cache',
    'build',
    'coverage',
    'dist',
];

/** Remove generated build outputs and the Turbo task cache from a workspace. */
export function cleanWorkspace(root = workspaceRoot) {
    const packageDirectories = PROJECT_FOLDERS.flatMap((group) =>
        discoverComponents(root, group).map(({ directory }) => directory),
    );
    for (const directory of [root, ...packageDirectories]) {
        for (const output of BASE_DIRS) rmSync(resolve(directory, output), { recursive: true, force: true });
    }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    cleanWorkspace();
}
