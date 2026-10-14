import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('accepts generated API links when the ignored API output is absent', () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-doc-check-'));

    try {
        for (const entry of [
            'AGENTS.md',
            'README.md',
            'actions',
            'benchmarks',
            'packages',
            'extensions',
            'scripts',
            'plans',
            '.agents',
            '.github',
            'package.json',
            'biome.json',
        ]) {
            const source = path.join(repositoryRoot, entry);
            if (!fs.existsSync(source)) continue;

            const destination = path.join(temporaryRoot, entry);
            const type = fs.statSync(source).isDirectory()
                ? process.platform === 'win32'
                    ? 'junction'
                    : 'dir'
                : 'file';
            fs.symlinkSync(source, destination, type);
        }

        const sourceTools = path.join(repositoryRoot, 'tools');
        const destinationTools = path.join(temporaryRoot, 'tools');
        fs.mkdirSync(destinationTools);
        for (const entry of fs.readdirSync(sourceTools)) {
            if (entry === 'build') continue;

            const source = path.join(sourceTools, entry);
            const destination = path.join(destinationTools, entry);
            fs.symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
        }

        const sourceBuild = path.join(sourceTools, 'build');
        fs.cpSync(sourceBuild, path.join(destinationTools, 'build'), {
            recursive: true,
            filter: (source) => {
                const relative = path.relative(sourceBuild, source).split(path.sep).join('/');
                return !['build', 'coverage', 'dist', 'node_modules'].some(
                    (directory) => relative === directory || relative.startsWith(`${directory}/`),
                );
            },
        });

        const sourceDocs = path.join(repositoryRoot, 'docs');
        fs.cpSync(sourceDocs, path.join(temporaryRoot, 'docs'), {
            recursive: true,
            filter: (source) => {
                const relative = path.relative(sourceDocs, source).split(path.sep).join('/');
                return relative !== 'api' && !relative.startsWith('api/') && !relative.includes('/dist/');
            },
        });

        const result = spawnSync(process.execPath, [path.join(repositoryRoot, 'scripts/check-docs.mjs')], {
            cwd: repositoryRoot,
            encoding: 'utf8',
            env: { ...process.env, PUMPKIN_PLUGINS_ROOT: temporaryRoot },
        });

        assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});
