import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Resolve the project directory used for runtime caches and toolchain files.
 *
 * @param workingDirectory - Consumer working directory; defaults to the current directory.
 * @returns The nearest pnpm workspace root, or the working directory when none contains it.
 */
export function resolveConsumerWorkspaceRoot(workingDirectory?: string): string {
    const currentWorkingDirectory = workingDirectory ?? currentWorkingDirectoryPath();
    const resolvedWorkingDirectory = path.resolve(currentWorkingDirectory);
    let directory = resolvedWorkingDirectory;
    while (true) {
        if (fs.existsSync(path.join(directory, 'pnpm-workspace.yaml'))) return directory;
        const parent = path.dirname(directory);
        if (parent === directory) return resolvedWorkingDirectory;
        directory = parent;
    }
}

function currentWorkingDirectoryPath(): string {
    const currentDirectory = process.cwd();
    const logicalDirectory = process.env.PWD;
    if (!logicalDirectory || !path.isAbsolute(logicalDirectory)) return currentDirectory;

    try {
        if (fs.realpathSync(logicalDirectory) === fs.realpathSync(currentDirectory)) return logicalDirectory;
    } catch {
        // Fall back to Node's current directory if PWD is stale or inaccessible.
    }
    return currentDirectory;
}
