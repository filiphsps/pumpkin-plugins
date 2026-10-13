import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { ensurePumpkinWit, parsePumpkinWitPin } from '../src/wit.mjs';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
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
    expect(schema.properties.$schema.const).toBe('schemas/upstream-git-pin.schema.json');
    expect(schema.properties.subdirectory.minLength).toBe(1);
    expect(parsePumpkinWitPin(JSON.stringify(lock), lockFile)).toMatchObject({
        repository: lock.repository,
        branch: lock.branch,
        commit: lock.commit,
        subdirectory: lock.subdirectory
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

it('refetches a cached WIT file when its contents no longer match the integrity manifest', () => {
    const directory = createLocalWitPin();
    const witRoot = ensurePumpkinWit({ lockFile: directory.lockFile, cacheRoot: directory.cacheRoot });
    const cachedPluginWit = path.join(witRoot, 'plugin.wit');

    fs.writeFileSync(cachedPluginWit, 'package pumpkin:plugin@9.9.9;\n');

    expect(ensurePumpkinWit({ lockFile: directory.lockFile, cacheRoot: directory.cacheRoot })).toBe(witRoot);
    expect(fs.readFileSync(cachedPluginWit, 'utf8')).toBe('package pumpkin:plugin@0.1.0;\n');
});

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
        { path: 'plugin.wit', sha256: createHash('sha256').update('package pumpkin:plugin@0.1.0;\n').digest('hex') }
    ]);
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

it('rechecks a stale cache-lock owner after claiming stale-lock recovery', async () => {
    const directory = createLocalWitPin();
    const lock = createStaleCacheLock(directory);
    const markers = createLockWorkerMarkers(directory.root);
    const hookFile = createLockWorkerHook(directory.root);
    const waiter = spawnWitWorker('waiter', directory, lock, markers, hookFile);
    let builder: WitWorker | undefined;

    try {
        await waitForFile(markers.waiterReadStaleOwner);
        builder = spawnWitWorker('builder', directory, lock, markers, hookFile);
        await waitForFile(markers.builderPausedAtClone);
        expect(JSON.parse(fs.readFileSync(path.join(lock.lockDirectory, 'owner.json'), 'utf8')).pid).toBe(
            builder.child.pid
        );

        fs.writeFileSync(markers.continueWaiter, 'continue');
        await waitForAnyFile([markers.waiterReadCurrentOwner, markers.waiterRemovedLock, markers.waiterStartedClone]);

        expect(fs.existsSync(markers.waiterReadCurrentOwner)).toBe(true);
        expect(fs.existsSync(markers.waiterRemovedLock)).toBe(false);
        expect(fs.existsSync(markers.waiterStartedClone)).toBe(false);

        fs.writeFileSync(markers.continueBuilder, 'continue');
        const results = await Promise.all([waitForWorker(waiter), waitForWorker(builder)]);
        expect(results.every((result) => result.code === 0)).toBe(true);
        const waiterWitRoot = results[0].output.trim();
        const builderWitRoot = results[1].output.trim();
        expect(waiterWitRoot).toBe(builderWitRoot);
        expect(fs.readFileSync(path.join(waiterWitRoot, 'plugin.wit'), 'utf8')).toBe('package pumpkin:plugin@0.1.0;\n');
    } finally {
        fs.writeFileSync(markers.continueWaiter, 'continue');
        fs.writeFileSync(markers.continueBuilder, 'continue');
        await stopWorker(waiter);
        if (builder) await stopWorker(builder);
    }
});

it('recovers a stale cache lock when its recovery owner has exited', () => {
    const directory = createLocalWitPin();
    const lock = createStaleCacheLock(directory);
    const reclaimDirectory = `${lock.lockDirectory}.reclaim`;
    fs.mkdirSync(reclaimDirectory);
    fs.writeFileSync(
        path.join(reclaimDirectory, 'owner.json'),
        JSON.stringify({ pid: lock.stalePid, token: 'abandoned-recovery' })
    );
    vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_001).mockReturnValue(1_000_000);

    const witRoot = ensurePumpkinWit({ lockFile: directory.lockFile, cacheRoot: directory.cacheRoot });

    expect(fs.readFileSync(path.join(witRoot, 'plugin.wit'), 'utf8')).toBe('package pumpkin:plugin@0.1.0;\n');
    expect(fs.existsSync(lock.lockDirectory)).toBe(false);
    expect(fs.existsSync(reclaimDirectory)).toBe(false);
});

it('keeps a live cache-lock recovery owner while waiting for a stale lock', () => {
    const directory = createLocalWitPin();
    const lock = createStaleCacheLock(directory);
    const reclaimDirectory = `${lock.lockDirectory}.reclaim`;
    const reclaimOwner = { pid: process.pid, token: 'live-recovery' };
    const reclaimContents = JSON.stringify(reclaimOwner);
    fs.mkdirSync(reclaimDirectory);
    fs.writeFileSync(path.join(reclaimDirectory, 'owner.json'), reclaimContents);
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(1_001).mockReturnValue(1_000_000);

    expect(() => ensurePumpkinWit({ lockFile: directory.lockFile, cacheRoot: directory.cacheRoot })).toThrow(
        `stale-lock recovery claim: ${reclaimDirectory}`
    );

    expect(fs.existsSync(lock.lockDirectory)).toBe(true);
    expect(fs.readFileSync(path.join(reclaimDirectory, 'owner.json'), 'utf8')).toBe(reclaimContents);
});

it('removes the cache lock when writing its owner file fails', async () => {
    const directory = createLocalWitPin();
    const lock = createStaleCacheLock(directory, false);
    const markers = createLockWorkerMarkers(directory.root);
    const hookFile = createLockWorkerHook(directory.root);
    const worker = spawnWitWorker('fail-owner-write', directory, lock, markers, hookFile);

    try {
        const result = await waitForWorker(worker);

        expect(result.code).not.toBe(0);
        expect(result.output).toContain('injected owner write failure');
        expect(fs.existsSync(lock.lockDirectory)).toBe(false);
    } finally {
        await stopWorker(worker);
    }
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
    return { root: directory, repository, lockFile, cacheRoot, commit };
}

function createStaleCacheLock(directory: ReturnType<typeof createLocalWitPin>, stale = true) {
    const lockDigest = createHash('sha256').update(fs.readFileSync(directory.lockFile)).digest('hex');
    const lockParent = path.join(directory.cacheRoot, 'pumpkin-api-wit');
    const lockDirectory = path.join(lockParent, `.${lockDigest}.lock`);

    let stalePid = process.pid;
    if (stale) {
        fs.mkdirSync(lockDirectory, { recursive: true });
        const exitedProcess = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
        if (exitedProcess.error) throw exitedProcess.error;
        if (exitedProcess.status !== 0 || !exitedProcess.pid) {
            throw new Error('could not create a dead cache-lock owner');
        }
        stalePid = exitedProcess.pid;
    }

    if (stale) fs.writeFileSync(path.join(lockDirectory, 'owner.json'), JSON.stringify({ pid: stalePid }));
    return { lockDirectory, stalePid };
}

function createLockWorkerMarkers(root: string) {
    return {
        waiterReadStaleOwner: path.join(root, 'waiter-read-stale-owner'),
        waiterReadCurrentOwner: path.join(root, 'waiter-read-current-owner'),
        waiterRemovedLock: path.join(root, 'waiter-removed-lock'),
        waiterStartedClone: path.join(root, 'waiter-started-clone'),
        builderPausedAtClone: path.join(root, 'builder-paused-at-clone'),
        continueWaiter: path.join(root, 'continue-waiter'),
        continueBuilder: path.join(root, 'continue-builder')
    };
}

function createLockWorkerHook(root: string) {
    const hookFile = path.join(root, 'wit-lock-worker-hook.mjs');
    fs.writeFileSync(
        hookFile,
        `import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const role = process.env.PUMPKIN_WIT_WORKER_ROLE;
const lockDirectory = path.resolve(process.env.PUMPKIN_WIT_LOCK_DIRECTORY);
const markers = JSON.parse(process.env.PUMPKIN_WIT_WORKER_MARKERS);
const stalePid = Number(process.env.PUMPKIN_WIT_STALE_PID);
const originalReadFileSync = fs.readFileSync.bind(fs);
const originalWriteFileSync = fs.writeFileSync.bind(fs);
const originalRmSync = fs.rmSync.bind(fs);
const originalExecFileSync = childProcess.execFileSync.bind(childProcess);

function mark(file, contents = 'seen') {
    originalWriteFileSync(file, contents);
}

function pauseUntilReleased(marker, release) {
    mark(marker);
    const delay = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    while (!fs.existsSync(release)) Atomics.wait(delay, 0, 0, 10);
}

if (role === 'waiter') {
    let pausedForStaleOwner = false;
    fs.readFileSync = (file, ...args) => {
        const contents = originalReadFileSync(file, ...args);
        if (path.resolve(String(file)) !== path.join(lockDirectory, 'owner.json')) return contents;
        const owner = JSON.parse(String(contents));
        if (!pausedForStaleOwner && owner.pid === stalePid) {
            pausedForStaleOwner = true;
            pauseUntilReleased(markers.waiterReadStaleOwner, markers.continueWaiter);
        } else if (owner.pid !== stalePid) {
            mark(markers.waiterReadCurrentOwner, String(owner.pid));
        }
        return contents;
    };
    fs.rmSync = (file, ...args) => {
        if (path.resolve(String(file)) === lockDirectory) mark(markers.waiterRemovedLock);
        return originalRmSync(file, ...args);
    };
    childProcess.execFileSync = (file, args, ...rest) => {
        if (file === 'git' && args?.[0] === 'clone') mark(markers.waiterStartedClone);
        return originalExecFileSync(file, args, ...rest);
    };
} else if (role === 'builder') {
    childProcess.execFileSync = (file, args, ...rest) => {
        if (file === 'git' && args?.[0] === 'clone') {
            pauseUntilReleased(markers.builderPausedAtClone, markers.continueBuilder);
        }
        return originalExecFileSync(file, args, ...rest);
    };
} else if (role === 'fail-owner-write') {
    fs.writeFileSync = (file, ...args) => {
        if (path.resolve(String(file)) === path.join(lockDirectory, 'owner.json')) {
            originalWriteFileSync(file, '{');
            throw new Error('injected owner write failure');
        }
        return originalWriteFileSync(file, ...args);
    };
}

syncBuiltinESMExports();
`
    );
    return hookFile;
}

function spawnWitWorker(
    role: string,
    directory: ReturnType<typeof createLocalWitPin>,
    lock: ReturnType<typeof createStaleCacheLock>,
    markers: ReturnType<typeof createLockWorkerMarkers>,
    hookFile: string
): WitWorker {
    const moduleUrl = pathToFileURL(path.join(apiRoot, 'src/wit.mjs')).href;
    const source =
        `import { ensurePumpkinWit } from ${JSON.stringify(moduleUrl)};\n` +
        'console.log(ensurePumpkinWit({ lockFile: process.env.PUMPKIN_WIT_LOCK_FILE, cacheRoot: process.env.PUMPKIN_WIT_CACHE_ROOT }));\n';
    const child = spawn(process.execPath, ['--import', hookFile, '--input-type=module', '-e', source], {
        env: {
            ...process.env,
            PUMPKIN_WIT_WORKER_ROLE: role,
            PUMPKIN_WIT_LOCK_DIRECTORY: lock.lockDirectory,
            PUMPKIN_WIT_LOCK_FILE: directory.lockFile,
            PUMPKIN_WIT_CACHE_ROOT: directory.cacheRoot,
            PUMPKIN_WIT_STALE_PID: String(lock.stalePid),
            PUMPKIN_WIT_WORKER_MARKERS: JSON.stringify(markers)
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const completion = new Promise<{ code: number | null; output: string }>((resolve) => {
        child.on('close', (code) => resolve({ code, output }));
    });
    return { child, completion };
}

async function waitForFile(file: string) {
    await waitForAnyFile([file]);
}

async function waitForAnyFile(files: string[]) {
    const timeout = Date.now() + 5_000;
    while (Date.now() < timeout) {
        if (files.some((file) => fs.existsSync(file))) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${files.join(', ')}`);
}

async function waitForWorker(worker: WitWorker) {
    let timeout: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            worker.completion,
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error('WIT worker did not exit')), 10_000);
            })
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

async function stopWorker(worker: WitWorker) {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
    worker.child.kill();
    let timeout: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            worker.completion,
            new Promise<void>((resolve) => {
                timeout = setTimeout(resolve, 1_000);
            })
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

type WitWorker = {
    child: ReturnType<typeof spawn>;
    completion: Promise<{ code: number | null; output: string }>;
};

function writeLocalWitLock(lockFile: string, repository: string, commit: string) {
    fs.writeFileSync(
        lockFile,
        `${JSON.stringify(
            {
                $schema: 'schemas/upstream-git-pin.schema.json',
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
