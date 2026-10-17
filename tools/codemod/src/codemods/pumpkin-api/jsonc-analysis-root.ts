import { copyFile, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';
import { parseJsonObject } from './jsonc.ts';

/** Creates a temporary resolver root when package.json is valid JSONC but not strict JSON. */
export async function createJsoncAnalysisRoot(
    projectRoot: string,
    entryPoint: string,
): Promise<{ root: string; tsconfig?: string; dispose: () => Promise<void> } | undefined> {
    let source: string;
    try {
        source = await readFile(path.join(projectRoot, 'package.json'), 'utf8');
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        throw error;
    }

    try {
        JSON.parse(source);
        return undefined;
    } catch {
        const parsed = parseJsonObject(source);
        if (!parsed.value) return undefined;
        const tsconfig = ts.findConfigFile(path.dirname(path.join(projectRoot, entryPoint)), ts.sys.fileExists);
        const mirror = await createMirroredRoot(projectRoot, parsed.value);
        return { ...mirror, ...(tsconfig ? { tsconfig } : {}) };
    }
}

/** Mirrors root files and links directories under a temporary resolver root. */
async function createMirroredRoot(
    projectRoot: string,
    manifest: Record<string, unknown>,
): Promise<{ root: string; dispose: () => Promise<void> }> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pumpkin-codemod-analysis-'));
    try {
        const entries = await readdir(projectRoot, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === 'package.json') {
                await writeFile(path.join(root, entry.name), `${JSON.stringify(manifest, null, 2)}\n`);
                continue;
            }
            const source = path.join(projectRoot, entry.name);
            const destination = path.join(root, entry.name);
            const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && (await stat(source)).isDirectory());
            if (isDirectory) {
                await symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
            } else if (entry.isFile() || entry.isSymbolicLink()) {
                await copyFile(source, destination);
            }
        }
    } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
    }

    return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}
