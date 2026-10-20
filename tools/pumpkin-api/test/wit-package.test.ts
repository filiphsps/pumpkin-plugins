import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { digestWitDirectory, ensurePumpkinWit, parsePumpkinWitPin } from '../src/wit.mjs';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectories: string[] = [];
const upstreamGitPinSchemaUrl =
    'https://raw.githubusercontent.com/filiphsps/pumpkin-plugins/master/tools/pumpkin-api/schemas/upstream-git-pin.schema.json';

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

it('publishes a schema requiring the same fields as the Pumpkin WIT pin parser', () => {
    const lockFile = path.join(apiRoot, 'wit.lock.json');
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    const schema = JSON.parse(fs.readFileSync(path.join(apiRoot, 'schemas/upstream-git-pin.schema.json'), 'utf8'));

    expect(schema.required).toEqual(['$schema', 'repository', 'branch', 'commit', 'subdirectory']);
    expect(schema.properties.subdirectory.minLength).toBe(1);
    expect(parsePumpkinWitPin(JSON.stringify(lock), lockFile)).toMatchObject({
        repository: lock.repository,
        branch: lock.branch,
        commit: lock.commit,
        subdirectory: lock.subdirectory,
    });
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
                cacheRoot: cacheAlias,
            }),
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
        subdirectory: 'wit',
    });

    fs.rmSync(directory.repository, { recursive: true, force: true });
    expect(ensurePumpkinWit({ lockFile: directory.lockFile, cacheRoot: directory.cacheRoot })).toBe(witRoot);
});

it('refetches a cached WIT file when its contents no longer match the integrity manifest', () => {
    const directory = createLocalWitPin();
    const witRoot = ensurePumpkinWit({ lockFile: directory.lockFile, cacheRoot: directory.cacheRoot });
    const cachedPluginWit = path.join(witRoot, 'plugin.wit');

    fs.writeFileSync(cachedPluginWit, 'package pumpkin:plugin@9.9.9;\n');

    expect(ensurePumpkinWit({ lockFile: directory.lockFile, cacheRoot: directory.cacheRoot })).toBe(witRoot);
    expect(fs.readFileSync(cachedPluginWit, 'utf8')).toBe('package pumpkin:plugin@0.1.0;\n');
}, 15_000);

it('refetches legacy cache metadata without a WIT integrity manifest', () => {
    const directory = createLocalWitPin();
    const witRoot = ensurePumpkinWit({ lockFile: directory.lockFile, cacheRoot: directory.cacheRoot });
    const cacheDirectory = path.dirname(witRoot);
    const pinFile = path.join(cacheDirectory, 'pin.json');
    const legacyPin = JSON.parse(fs.readFileSync(pinFile, 'utf8'));
    legacyPin.witFiles = undefined;
    fs.writeFileSync(pinFile, `${JSON.stringify(legacyPin, null, 4)}\n`);
    fs.writeFileSync(path.join(witRoot, 'plugin.wit'), 'package pumpkin:plugin@9.9.9;\n');

    expect(ensurePumpkinWit({ lockFile: directory.lockFile, cacheRoot: directory.cacheRoot })).toBe(witRoot);
    expect(fs.readFileSync(path.join(witRoot, 'plugin.wit'), 'utf8')).toBe('package pumpkin:plugin@0.1.0;\n');
    expect(JSON.parse(fs.readFileSync(pinFile, 'utf8')).witFiles).toEqual([
        { path: 'plugin.wit', sha256: createHash('sha256').update('package pumpkin:plugin@0.1.0;\n').digest('hex') },
    ]);
}, 15_000);

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

it('digests every WIT file under a package directory, including nested dependencies', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-wit-digest-'));
    temporaryDirectories.push(directory);
    fs.mkdirSync(path.join(directory, 'deps'));
    fs.writeFileSync(path.join(directory, 'plugin.wit'), 'package pumpkin:plugin@0.1.0;\n');
    fs.writeFileSync(path.join(directory, 'deps', 'types.wit'), 'interface types {}\n');
    const digest = digestWitDirectory(directory);

    fs.writeFileSync(path.join(directory, 'README.md'), 'not part of the WIT package\n');
    expect(digestWitDirectory(directory)).toBe(digest);

    fs.writeFileSync(path.join(directory, 'deps', 'types.wit'), 'interface types { type id = u32; }\n');
    expect(digestWitDirectory(directory)).toMatch(/^[a-f0-9]{64}$/);
    expect(digestWitDirectory(directory)).not.toBe(digest);
});

it('reports a pinned commit that has no WIT subdirectory', () => {
    const directory = createLocalWitPin();
    const lock = JSON.parse(fs.readFileSync(directory.lockFile, 'utf8'));
    fs.writeFileSync(directory.lockFile, JSON.stringify({ ...lock, subdirectory: 'missing' }));

    expect(() => ensurePumpkinWit({ lockFile: directory.lockFile, cacheRoot: directory.cacheRoot })).toThrow(
        /does not contain WIT files under missing\//,
    );
});

it('lets concurrent first builds fetch the same WIT pin', async () => {
    const directory = createLocalWitPin();

    const results = await Promise.all([runWitWorker(directory), runWitWorker(directory)]);

    expect(results.map(({ code }) => code)).toEqual([0, 0]);
    expect(results[0].output).toBe(results[1].output);
    expect(fs.readFileSync(path.join(results[0].output, 'plugin.wit'), 'utf8')).toBe('package pumpkin:plugin@0.1.0;\n');
    expect(fs.readdirSync(path.join(directory.cacheRoot, 'pumpkin-api-wit'))).toEqual([
        path.basename(path.dirname(results[0].output)),
    ]);
}, 15_000);

it('does not wait for a cache lock left by a crashed build whose PID is in use again', async () => {
    const directory = createLocalWitPin();
    const lockDigest = createHash('sha256').update(fs.readFileSync(directory.lockFile)).digest('hex');
    const leftoverLock = path.join(directory.cacheRoot, 'pumpkin-api-wit', `.${lockDigest}.lock`);
    fs.mkdirSync(leftoverLock, { recursive: true });
    fs.writeFileSync(path.join(leftoverLock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'crashed' }));

    const result = await runWitWorker(directory);

    expect(result.code).toBe(0);
    expect(fs.readFileSync(path.join(result.output, 'plugin.wit'), 'utf8')).toBe('package pumpkin:plugin@0.1.0;\n');
}, 15_000);

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
    return { root: directory, repository, lockFile, cacheRoot, commit };
}

async function runWitWorker(directory: ReturnType<typeof createLocalWitPin>) {
    const moduleUrl = pathToFileURL(path.join(apiRoot, 'src/wit.mjs')).href;
    const source =
        `import { ensurePumpkinWit } from ${JSON.stringify(moduleUrl)};\n` +
        `console.log(ensurePumpkinWit(${JSON.stringify({ lockFile: directory.lockFile, cacheRoot: directory.cacheRoot })}));\n`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const timeout = setTimeout(() => child.kill(), 10_000);
    try {
        const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
        return { code, output: output.trim() };
    } finally {
        clearTimeout(timeout);
    }
}

function writeLocalWitLock(lockFile: string, repository: string, commit: string) {
    fs.writeFileSync(
        lockFile,
        `${JSON.stringify(
            {
                $schema: upstreamGitPinSchemaUrl,
                repository: pathToFileURL(repository).href,
                branch: 'main',
                commit,
                subdirectory: 'wit',
            },
            null,
            4,
        )}\n`,
    );
}

function runGit(directory: string, args: string[]) {
    return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
}
