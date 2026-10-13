import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { ensurePumpkinWit } from '../src/wit.mjs';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

it('exports its WIT lock without vendoring the fetched WIT', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(apiRoot, 'package.json'), 'utf8'));
    expect(packageJson.exports['./package.json']).toBe('./package.json');
    expect(packageJson.files).toContain('wit.lock.json');
    expect(packageJson.files).not.toContain('wit');
    expect(fs.existsSync(path.join(apiRoot, 'wit'))).toBe(false);
});

it('rejects cache roots symlinked into node_modules', () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-wit-cache-symlink-'));
    try {
        const nodeModules = path.join(temporaryRoot, 'node_modules');
        const cacheAlias = path.join(temporaryRoot, 'cache');
        fs.mkdirSync(nodeModules);
        fs.symlinkSync(nodeModules, cacheAlias, process.platform === 'win32' ? 'junction' : 'dir');

        expect(() =>
            ensurePumpkinWit({
                lockFile: path.join(apiRoot, 'wit.lock.json'),
                cacheRoot: cacheAlias
            })
        ).toThrow(/must stay outside node_modules and the pnpm store/);
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

it('fetches a local WIT pin and reuses its verified cache without the Git source', () => {
    const directory = createLocalWitPin();
    const witRoot = ensurePumpkinWit({ lockFile: directory.lockFile, cacheRoot: directory.cacheRoot });

    expect(fs.readFileSync(path.join(witRoot, 'plugin.wit'), 'utf8')).toBe('package pumpkin:plugin@0.1.0;\n');
    expect(JSON.parse(fs.readFileSync(path.join(path.dirname(witRoot), 'pin.json'), 'utf8'))).toMatchObject({
        lockDigest: createHash('sha256').update(fs.readFileSync(directory.lockFile)).digest('hex'),
        commit: directory.commit,
        subdirectory: 'wit'
    });

    fs.rmSync(directory.repository, { recursive: true, force: true });
    expect(ensurePumpkinWit({ lockFile: directory.lockFile, cacheRoot: directory.cacheRoot })).toBe(witRoot);
});

it('fetches the new local Git commit when the WIT lock changes', () => {
    const directory = createLocalWitPin();
    const firstWitRoot = ensurePumpkinWit({ lockFile: directory.lockFile, cacheRoot: directory.cacheRoot });

    fs.writeFileSync(path.join(directory.repository, 'wit', 'plugin.wit'), 'package pumpkin:plugin@0.2.0;\n');
    runGit(directory.repository, ['add', 'wit/plugin.wit']);
    runGit(directory.repository, ['commit', '--quiet', '-m', 'Update WIT package']);
    const nextCommit = runGit(directory.repository, ['rev-parse', 'HEAD']);
    writeLocalWitLock(directory.lockFile, directory.repository, nextCommit);

    const nextWitRoot = ensurePumpkinWit({ lockFile: directory.lockFile, cacheRoot: directory.cacheRoot });

    expect(nextWitRoot).not.toBe(firstWitRoot);
    expect(fs.readFileSync(path.join(nextWitRoot, 'plugin.wit'), 'utf8')).toBe('package pumpkin:plugin@0.2.0;\n');
});

function createLocalWitPin() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-wit-local-git-'));
    temporaryDirectories.push(directory);
    const repository = path.join(directory, 'upstream');
    const lockFile = path.join(directory, 'wit.lock.json');
    const cacheRoot = path.join(directory, 'cache');
    fs.mkdirSync(path.join(repository, 'wit'), { recursive: true });
    runGit(directory, ['init', '--quiet', repository]);
    runGit(repository, ['config', 'user.name', 'Pumpkin API tests']);
    runGit(repository, ['config', 'user.email', 'pumpkin-api-tests@example.invalid']);
    runGit(repository, ['checkout', '--quiet', '-b', 'main']);
    fs.writeFileSync(path.join(repository, 'wit', 'plugin.wit'), 'package pumpkin:plugin@0.1.0;\n');
    runGit(repository, ['add', 'wit/plugin.wit']);
    runGit(repository, ['commit', '--quiet', '-m', 'Add WIT package']);
    const commit = runGit(repository, ['rev-parse', 'HEAD']);
    writeLocalWitLock(lockFile, repository, commit);
    return { repository, lockFile, cacheRoot, commit };
}

function writeLocalWitLock(lockFile: string, repository: string, commit: string) {
    fs.writeFileSync(
        lockFile,
        `${JSON.stringify(
            {
                $schema: '../../schemas/upstream-git-pin.schema.json',
                repository: pathToFileURL(repository).href,
                branch: 'main',
                commit,
                subdirectory: 'wit'
            },
            null,
            4
        )}\n`
    );
}

function runGit(directory: string, args: string[]) {
    return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
}
