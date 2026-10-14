import { randomUUID } from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import type {
    CodemodDefinition,
    CodemodFileChange,
    CodemodMessage,
    CodemodRunReport,
    RunCodemodOptions,
} from './types.js';

const IGNORED_DIRECTORIES = new Set(['.git', '.cache', '.turbo', 'build', 'coverage', 'dist', 'node_modules']);

/** Finds matching files, transforms them, and writes changes only when requested.
 *
 * @throws {Error} If an input path cannot be read, a transform fails or a write fails. Write errors
 * include any files already updated in the run.
 */
export async function runCodemod(
    codemod: CodemodDefinition,
    inputs: readonly string[],
    options: RunCodemodOptions = {},
): Promise<CodemodRunReport> {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const files = await discoverFiles(codemod, inputs, cwd);
    const changedFiles: CodemodFileChange[] = [];
    const messages: CodemodMessage[] = [];

    for (const absolutePath of files) {
        const relativePath = toPosixPath(path.relative(cwd, absolutePath));
        const before = await fs.readFile(absolutePath, 'utf8');
        const result = codemod.transform({ absolutePath, projectRoot: cwd, relativePath, source: before });
        messages.push(...(result.messages ?? []).map((text) => ({ relativePath, text })));
        if (result.source === before) continue;
        changedFiles.push({ absolutePath, before, after: result.source, relativePath });
    }

    if (options.write && changedFiles.length > 0) {
        const writtenFiles: string[] = [];
        for (const change of changedFiles) {
            try {
                await writeFileAtomically(change);
                writtenFiles.push(change.relativePath);
            } catch (error) {
                const updated = writtenFiles.length > 0 ? writtenFiles.join(', ') : 'none';
                throw new Error(`Failed to write ${change.relativePath}; already updated: ${updated}`, {
                    cause: error,
                });
            }
        }
    }

    return {
        filesScanned: files.length,
        changedFiles,
        messages,
        wroteFiles: options.write === true && changedFiles.length > 0,
    };
}

/** Replaces one file atomically while preserving its permission bits. */
async function writeFileAtomically(change: CodemodFileChange): Promise<void> {
    const temporaryPath = path.join(path.dirname(change.absolutePath), `.pumpkin-codemod-${randomUUID()}.tmp`);
    let fileHandle: FileHandle | undefined;
    let temporaryCreated = false;
    try {
        const originalMode = (await fs.stat(change.absolutePath)).mode;
        fileHandle = await fs.open(temporaryPath, 'wx', originalMode & 0o777);
        temporaryCreated = true;
        await fileHandle.writeFile(change.after, 'utf8');
        await fileHandle.chmod(originalMode & 0o7777);
        await fileHandle.close();
        fileHandle = undefined;
        await fs.rename(temporaryPath, change.absolutePath);
    } catch (error) {
        if (fileHandle) await fileHandle.close().catch(() => undefined);
        if (temporaryCreated) await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

/** Recursively finds selected regular files under the requested paths.
 *
 * @throws {Error} If an input path does not exist or cannot be read.
 */
async function discoverFiles(codemod: CodemodDefinition, inputs: readonly string[], cwd: string): Promise<string[]> {
    const found = new Set<string>();

    for (const input of inputs) {
        const absolutePath = path.resolve(cwd, input);
        const stats = await fs.lstat(absolutePath);
        if (stats.isSymbolicLink()) continue;
        if (stats.isFile()) {
            if (codemod.matchesFile(toPosixPath(path.relative(cwd, absolutePath)))) found.add(absolutePath);
            continue;
        }
        if (!stats.isDirectory()) continue;
        await collectDirectory(codemod, absolutePath, cwd, found);
    }

    return [...found].sort((left, right) => left.localeCompare(right));
}

/** Adds selected files from one directory tree, skipping generated and dependency folders. */
async function collectDirectory(
    codemod: CodemodDefinition,
    directory: string,
    cwd: string,
    found: Set<string>,
): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            if (!IGNORED_DIRECTORIES.has(entry.name)) await collectDirectory(codemod, absolutePath, cwd, found);
        } else if (entry.isFile() && codemod.matchesFile(toPosixPath(path.relative(cwd, absolutePath)))) {
            found.add(absolutePath);
        }
    }
}

/** Normalizes paths for codemod file matching and cross-platform reports. */
function toPosixPath(value: string): string {
    return value.split(path.sep).join('/');
}
