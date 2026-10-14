import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LatestVersionOptions } from '@badisi/latest-version';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from './cli.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
    );
});

async function createProject(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pumpkin-codemod-cli-'));
    temporaryDirectories.push(directory);
    return directory;
}

describe('pumpkin-codemod CLI', () => {
    it('lists registered codemods with their descriptions', async () => {
        const output: string[] = [];
        const code = await runCli(['node', 'pumpkin-codemod', 'list'], { stdout: (text) => output.push(text) });

        expect(code).toBe(0);
        expect(output.join('')).toContain('migrate-pumpkin-api-ts');
        expect(output.join('')).toContain('@pumpkin-plugins/pumpkin-api');
        expect(output.join('')).toContain('update-build');
    });

    it('previews update-build output by default and prints the complete changed package file', async () => {
        const root = await createProject();
        const source = '{\n    "dependencies": { "@pumpkin-plugins/build": "^0.1.0" }\n}\n';
        await fs.writeFile(path.join(root, 'package.json'), source);
        const output: string[] = [];
        const registryLookup = vi.fn(async (_packageName: string, _options?: LatestVersionOptions) => ({
            name: '@pumpkin-plugins/build',
            latest: '0.2.0',
            updatesAvailable: false as const,
        }));

        const code = await runCli(['node', 'pumpkin-codemod', 'update-build', '.', '--print'], {
            cwd: root,
            stdout: (text) => output.push(text),
            updateBuild: { lookup: registryLookup, resolveInstalledVersion: () => '0.1.0' },
        });

        expect(code).toBe(0);
        expect(await fs.readFile(path.join(root, 'package.json'), 'utf8')).toBe(source);
        expect(output.join('')).toContain('"@pumpkin-plugins/build": "^0.2.0"');
        expect(output.join('')).toContain('Would update 1 file(s)');
        expect(output.join('')).toContain('run your package manager');
    });

    it('writes update-build changes only with --write', async () => {
        const root = await createProject();
        const source = '{\n    "dependencies": { "@pumpkin-plugins/build": "^0.1.0" }\n}\n';
        await fs.writeFile(path.join(root, 'package.json'), source);
        const registryLookup = vi.fn(async (_packageName: string, _options?: LatestVersionOptions) => ({
            name: '@pumpkin-plugins/build',
            latest: '0.2.0',
            updatesAvailable: false as const,
        }));

        const code = await runCli(['node', 'pumpkin-codemod', 'update-build', '.', '--write'], {
            cwd: root,
            stdout: () => undefined,
            updateBuild: { lookup: registryLookup, resolveInstalledVersion: () => '0.1.0' },
        });

        expect(code).toBe(0);
        expect(await fs.readFile(path.join(root, 'package.json'), 'utf8')).toContain(
            '"@pumpkin-plugins/build": "^0.2.0"',
        );
    });

    it('previews the migration by default and writes files only with --write', async () => {
        const root = await createProject();
        const sourcePath = path.join(root, 'plugin.ts');
        const source = "import { Plugin } from '@pumpkinmc/pumpkin-api-ts';\n";
        await fs.writeFile(sourcePath, source);

        const output: string[] = [];
        const code = await runCli(['node', 'pumpkin-codemod', 'migrate-pumpkin-api-ts', '.'], {
            cwd: root,
            stdout: (text) => output.push(text),
        });

        expect(code).toBe(0);
        expect(await fs.readFile(sourcePath, 'utf8')).toBe(source);
        expect(output.join('')).toContain('plugin.ts');

        const writeCode = await runCli(['node', 'pumpkin-codemod', 'migrate-pumpkin-api-ts', '.', '--write'], {
            cwd: root,
            stdout: () => undefined,
        });

        expect(writeCode).toBe(0);
        expect(await fs.readFile(sourcePath, 'utf8')).toBe("import { Plugin } from '@pumpkin-plugins/pumpkin-api';\n");
    });

    it('reports unknown codemod names with a non-zero exit code', async () => {
        const errors: string[] = [];
        const code = await runCli(['node', 'pumpkin-codemod', 'missing-codemod'], {
            stderr: (text) => errors.push(text),
        });

        expect(code).toBe(1);
        expect(errors.join('')).toContain('Unknown codemod');
    });
});
