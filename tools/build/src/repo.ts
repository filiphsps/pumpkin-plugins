import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Finds the repository root: the closest folder above `from` with a `pnpm-workspace.yaml`.
 * @param from - A folder inside the repository.
 * @returns The root, or `from` itself when none is found.
 */
export function findRepoRoot(from: string): string {
    for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
        if (path.dirname(dir) === dir) return path.resolve(from);
    }
}

/**
 * Where downloaded build inputs are cached: `PUMPKIN_PLUGINS_CACHE_DIR`, or `.cache` in the repository root.
 * @param from - A folder inside the repository.
 * @returns The cache folder. It may not exist yet.
 */
export function cacheDir(from: string): string {
    return process.env.PUMPKIN_PLUGINS_CACHE_DIR || path.join(findRepoRoot(from), '.cache');
}
