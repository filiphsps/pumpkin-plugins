import fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCodemod } from './runner.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
    );
});

async function createProject(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pumpkin-codemod-'));
    temporaryDirectories.push(directory);
    return directory;
}

describe('runCodemod', () => {
    it('shows recursive changes in dry-run mode and leaves project files untouched', async () => {
        const root = await createProject();
        const sourcePath = path.join(root, 'src', 'plugin.ts');
        const generatedPath = path.join(root, 'node_modules', 'dep', 'plugin.ts');
        await fs.mkdir(path.dirname(sourcePath), { recursive: true });
        await fs.mkdir(path.dirname(generatedPath), { recursive: true });
        await fs.writeFile(sourcePath, 'old API');
        await fs.writeFile(generatedPath, 'old API');

        const report = await runCodemod(
            {
                id: 'replace-api',
                description: 'Replace a test API marker.',
                matchesFile: (relativePath) => relativePath.endsWith('.ts'),
                transform: ({ source }) => ({ source: source.replace('old API', 'new API') }),
            },
            [root],
            { cwd: root },
        );

        expect(report.changedFiles.map(({ relativePath }) => relativePath)).toEqual(['src/plugin.ts']);
        expect(await fs.readFile(sourcePath, 'utf8')).toBe('old API');
        expect(report.wroteFiles).toBe(false);
    });

    it('writes only transformed files when write mode is enabled', async () => {
        const root = await createProject();
        const sourcePath = path.join(root, 'plugin.ts');
        await fs.writeFile(sourcePath, 'old API');

        const report = await runCodemod(
            {
                id: 'replace-api',
                description: 'Replace a test API marker.',
                matchesFile: (relativePath) => relativePath.endsWith('.ts'),
                transform: ({ source }) => ({ source: source.replace('old API', 'new API') }),
            },
            [sourcePath],
            { cwd: root, write: true },
        );

        expect(await fs.readFile(sourcePath, 'utf8')).toBe('new API');
        expect(report.wroteFiles).toBe(true);
        expect(report.changedFiles).toHaveLength(1);
    });

    it('writes files atomically and reports files already updated after a later write fails', async () => {
        const root = await createProject();
        const firstPath = path.join(root, 'a.ts');
        const secondPath = path.join(root, 'b.ts');
        await fs.writeFile(firstPath, 'old API');
        await fs.writeFile(secondPath, 'old API');
        const originalRename = fs.rename;
        const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
            if (destination === secondPath) throw new Error('simulated rename failure');
            return originalRename(source, destination);
        });

        try {
            await expect(
                runCodemod(
                    {
                        id: 'replace-api',
                        description: 'Replace a test API marker.',
                        matchesFile: (relativePath) => relativePath.endsWith('.ts'),
                        transform: ({ source }) => ({ source: source.replace('old API', 'new API') }),
                    },
                    [root],
                    { cwd: root, write: true },
                ),
            ).rejects.toThrow('Failed to write b.ts; already updated: a.ts');

            expect(await fs.readFile(firstPath, 'utf8')).toBe('new API');
            expect(await fs.readFile(secondPath, 'utf8')).toBe('old API');
            expect((await fs.readdir(root)).some((name) => name.startsWith('.pumpkin-codemod-'))).toBe(false);
        } finally {
            renameSpy.mockRestore();
        }
    });

    it('does not rewrite files when a transform returns the original content', async () => {
        const root = await createProject();
        const sourcePath = path.join(root, 'plugin.ts');
        await fs.writeFile(sourcePath, 'already migrated');

        const report = await runCodemod(
            {
                id: 'replace-api',
                description: 'Replace a test API marker.',
                matchesFile: (relativePath) => relativePath.endsWith('.ts'),
                transform: ({ source }) => ({ source }),
            },
            [sourcePath],
            { cwd: root, write: true },
        );

        expect(report.changedFiles).toEqual([]);
        expect(report.wroteFiles).toBe(false);
    });

    it('does not traverse a directory symlink passed as an input', async () => {
        const root = await createProject();
        const target = path.join(root, 'target');
        await fs.mkdir(target);
        await fs.writeFile(path.join(target, 'plugin.ts'), 'old API');
        const linked = path.join(root, 'linked');
        try {
            await fs.symlink(target, linked, 'dir');
        } catch (error) {
            if (
                error &&
                typeof error === 'object' &&
                'code' in error &&
                ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))
            ) {
                return;
            }
            throw error;
        }

        const report = await runCodemod(
            {
                id: 'replace-api',
                description: 'Replace a test API marker.',
                matchesFile: (relativePath) => relativePath.endsWith('.ts'),
                transform: ({ source }) => ({ source: source.replace('old API', 'new API') }),
            },
            [linked],
            { cwd: root },
        );

        expect(report.filesScanned).toBe(0);
        expect(report.changedFiles).toEqual([]);
    });
});
