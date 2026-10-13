import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { acquireHermesBuildLock, isHermesBuildCacheCurrent, saveHermesBuildCache } from '../src/hermes/build.ts';
import { applyHermesPatchSeries, readHermesPatchSeries } from '../src/hermes/patch.ts';
import {
    ensureHermesSource,
    parseHermesSourcePin,
    readHermesSourcePin,
    refreshHermesSource
} from '../src/hermes/source.ts';
import type { HermesProcessRunner } from '../src/hermes/system.ts';

const directories: string[] = [];
const pin = {
    repository: 'https://github.com/facebook/hermes.git',
    branch: 'static_h',
    commit: '820aa0d4b5fe5d3ed7900e1274211ef561081b3f'
};

afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

it('validates Hermes source pin shape before invoking Git', () => {
    expect(parseHermesSourcePin(pin)).toEqual(pin);
    expect(() => parseHermesSourcePin({ ...pin, commit: '1234' })).toThrow('40-character commit SHA');
    expect(() => parseHermesSourcePin({ ...pin, repository: 'file:///tmp/hermes.git' })).toThrow('public HTTPS URL');
});

it('reports a missing source pin with its path', () => {
    const root = temporaryDirectory();
    expect(() => readHermesSourcePin(path.join(root, 'missing.json'))).toThrow(/Hermes source pin not found/);
});

it('clones and validates the pinned checkout through an injectable Git runner', () => {
    const root = temporaryDirectory();
    const source = path.join(root, 'source');
    const commits = new Map<string, string>();
    const runner: HermesProcessRunner = {
        run(_command, args) {
            if (args[0] === 'clone') {
                const destination = args.at(-1);
                if (destination === undefined) throw new Error('Git clone destination is missing');
                fs.mkdirSync(path.join(destination, '.git'), { recursive: true });
                commits.set(destination, 'not-checked-out');
            } else if (args[0] === '-C' && args[2] === 'checkout') {
                const directory = args[1];
                if (directory === undefined) throw new Error('Git checkout directory is missing');
                commits.set(directory, pin.commit);
            }
        },
        output(_command, args) {
            if (args.includes('--git-dir')) return '.git';
            if (args.includes('HEAD')) {
                const directory = args[1];
                if (directory === undefined) throw new Error('Git HEAD directory is missing');
                return commits.get(directory) ?? '';
            }
            if (isPorcelainStatusCommand(args)) return '';
            throw new Error(`Unexpected Git command: ${args.join(' ')}`);
        },
        buffer() {
            return Buffer.alloc(0);
        }
    };

    expect(ensureHermesSource({ pin, source, managedSource: true, managedPaths: [], process: runner })).toBe(source);
    expect(fs.existsSync(path.join(source, '.git'))).toBe(true);
});

it('retries an initial Hermes clone after a failed fetch', () => {
    const root = temporaryDirectory();
    const source = path.join(root, 'source');
    let cloneAttempts = 0;
    let failFirstFetch = true;
    const runner: HermesProcessRunner = {
        run(_command, args) {
            if (args[0] === 'clone') {
                const destination = args.at(-1);
                if (destination === undefined) throw new Error('Git clone destination is missing');
                cloneAttempts += 1;
                fs.mkdirSync(path.join(destination, '.git'), { recursive: true });
            } else if (args[0] === '-C' && args[2] === 'fetch' && failFirstFetch) {
                failFirstFetch = false;
                throw new Error('network interrupted');
            } else if (args[0] === '-C' && args[2] === 'checkout') {
                const directory = args[1];
                if (directory === undefined) throw new Error('Git checkout directory is missing');
                fs.writeFileSync(path.join(directory, '.git', 'resolved-commit'), pin.commit);
            }
        },
        output(_command, args) {
            const directory = args[1];
            if (directory === undefined) throw new Error('Git source directory is missing');
            if (args.includes('--git-dir')) {
                if (!fs.existsSync(path.join(directory, '.git'))) throw new Error('not a Git checkout');
                return '.git';
            }
            if (args.includes('HEAD')) {
                return fs.readFileSync(path.join(directory, '.git', 'resolved-commit'), 'utf8');
            }
            if (isPorcelainStatusCommand(args)) return '';
            throw new Error(`Unexpected Git command: ${args.join(' ')}`);
        },
        buffer() {
            return Buffer.alloc(0);
        }
    };

    expect(() => ensureHermesSource({ pin, source, managedSource: true, managedPaths: [], process: runner })).toThrow(
        'network interrupted'
    );
    expect(fs.readdirSync(root)).toEqual([]);
    expect(ensureHermesSource({ pin, source, managedSource: true, managedPaths: [], process: runner })).toBe(source);
    expect(cloneAttempts).toBe(2);
});

it('discovers patches by numeric order and rejects gaps before applying', () => {
    const directory = temporaryDirectory();
    writePatch(directory, '0001-first.patch', 'first.txt');
    writePatch(directory, '0002-second.patch', 'second.txt');
    expect(readHermesPatchSeries(directory).map(({ name }) => name)).toEqual(['0001-first.patch', '0002-second.patch']);

    fs.renameSync(path.join(directory, '0002-second.patch'), path.join(directory, '0003-second.patch'));
    expect(() => readHermesPatchSeries(directory)).toThrow('expected 0002, found 0003-second.patch');
});

it('applies each ordered patch once and skips patches already applied', () => {
    const directory = temporaryDirectory();
    writePatch(directory, '0001-first.patch', 'first.txt');
    writePatch(directory, '0002-second.patch', 'second.txt');
    const patches = readHermesPatchSeries(directory);
    const applied = new Set<string>();
    const commands: string[] = [];
    const runner: HermesProcessRunner = {
        run(_command, args) {
            commands.push(args.join(' '));
            const filename = args.at(-1);
            if (filename === undefined) throw new Error('Git patch filename is missing');
            if (args.includes('--check')) {
                if (args.includes('--reverse') ? applied.has(filename) : !applied.has(filename)) return;
                throw new Error('patch check failed');
            }
            if (args.includes('apply')) applied.add(filename);
        },
        output(_command, args) {
            return isPorcelainStatusCommand(args) ? '' : 'git-dir';
        },
        buffer() {
            return Buffer.alloc(0);
        }
    };
    applyHermesPatchSeries({ source: directory, patches, process: runner });
    applyHermesPatchSeries({ source: directory, patches, process: runner });

    expect([...applied]).toHaveLength(2);
    expect(commands.filter((command) => command.includes(' apply ') && !command.includes('--check'))).toHaveLength(2);
});

it('rejects unrelated edits and patch conflicts with actionable paths', () => {
    const directory = temporaryDirectory();
    writePatch(directory, '0001-first.patch', 'first.txt');
    const patches = readHermesPatchSeries(directory);
    const conflictRunner: HermesProcessRunner = {
        run(_command, args) {
            if (args.includes('--check')) throw new Error('conflict');
        },
        output(_command, args) {
            if (isPorcelainStatusCommand(args)) return args.includes('-z') ? ' M unrelated.txt\0' : ' M unrelated.txt';
            return 'git-dir';
        },
        buffer() {
            return Buffer.alloc(0);
        }
    };

    expect(() => applyHermesPatchSeries({ source: directory, patches, process: conflictRunner })).toThrow(
        /outside the managed patch set.*unrelated.txt/
    );
    const cleanRunner = {
        ...conflictRunner,
        output: (_command: string, args: readonly string[]) => (isPorcelainStatusCommand(args) ? '' : 'git-dir')
    };
    expect(() => applyHermesPatchSeries({ source: directory, patches, process: cleanRunner })).toThrow(
        /does not apply to the pinned source.*0001-first.patch/
    );
});

it('rejects refreshing a managed rename whose destination is outside the patch set', () => {
    const root = temporaryDirectory();
    const source = path.join(root, 'source');
    let rebuildStarted = false;
    const runner: HermesProcessRunner = {
        run() {
            rebuildStarted = true;
            throw new Error('unexpected source rebuild');
        },
        output(_command, args) {
            if (isPorcelainStatusCommand(args)) {
                return args.includes('-z') ? 'R  unrelated.txt\0managed.txt\0' : 'R  managed.txt -> unrelated.txt';
            }
            if (args.includes('--git-dir')) return '.git';
            if (args.includes('HEAD')) return pin.commit;
            throw new Error(`Unexpected Git command: ${args.join(' ')}`);
        },
        buffer() {
            return Buffer.alloc(0);
        }
    };

    expect(() =>
        refreshHermesSource({ pin, source, managedSource: true, managedPaths: ['managed.txt'], process: runner })
    ).toThrow(/outside the managed patch set.*unrelated\.txt/);
    expect(rebuildStarted).toBe(false);
});

it('rejects patch application when a patch-owned rename targets an unrelated path', () => {
    const source = temporaryDirectory();
    let patchCheckStarted = false;
    const runner: HermesProcessRunner = {
        run() {
            patchCheckStarted = true;
            throw new Error('unexpected patch check');
        },
        output(_command, args) {
            if (isPorcelainStatusCommand(args)) {
                return args.includes('-z') ? 'R  unrelated.txt\0managed.txt\0' : 'R  managed.txt -> unrelated.txt';
            }
            throw new Error(`Unexpected Git command: ${args.join(' ')}`);
        },
        buffer() {
            return Buffer.alloc(0);
        }
    };

    expect(() =>
        applyHermesPatchSeries({
            source,
            patches: [
                {
                    name: '0001-managed.patch',
                    filename: '/patches/0001-managed.patch',
                    sequence: 1,
                    affectedPaths: ['managed.txt']
                }
            ],
            process: runner
        })
    ).toThrow(/outside the managed patch set.*unrelated\.txt/);
    expect(patchCheckStarted).toBe(false);
});

it('rejects patch application when a patch-owned copy targets an unrelated path', () => {
    const source = temporaryDirectory();
    const runner: HermesProcessRunner = {
        run() {
            throw new Error('unexpected patch check');
        },
        output(_command, args) {
            if (isPorcelainStatusCommand(args)) {
                return args.includes('-z')
                    ? 'C  unrelated-copy.txt\0managed.txt\0'
                    : 'C  managed.txt -> unrelated-copy.txt';
            }
            throw new Error(`Unexpected Git command: ${args.join(' ')}`);
        },
        buffer() {
            return Buffer.alloc(0);
        }
    };

    expect(() =>
        applyHermesPatchSeries({
            source,
            patches: [
                {
                    name: '0001-managed.patch',
                    filename: '/patches/0001-managed.patch',
                    sequence: 1,
                    affectedPaths: ['managed.txt']
                }
            ],
            process: runner
        })
    ).toThrow(/outside the managed patch set.*unrelated-copy\.txt/);
});

it('validates and atomically saves the build cache fingerprint', () => {
    const root = temporaryDirectory();
    const artifact = path.join(root, 'hermesvm.a');
    const state = path.join(root, 'prepared-build.json');
    fs.writeFileSync(artifact, 'archive');
    saveHermesBuildCache('a'.repeat(64), state, root);

    expect(isHermesBuildCacheCurrent('a'.repeat(64), state, [artifact])).toBe(true);
    expect(isHermesBuildCacheCurrent('b'.repeat(64), state, [artifact])).toBe(false);
    fs.writeFileSync(state, '{ invalid json');
    expect(isHermesBuildCacheCurrent('a'.repeat(64), state, [artifact])).toBe(false);
});

it('removes stale build locks, waits for live owners, and times out cleanly', async () => {
    const root = temporaryDirectory();
    const staleLock = path.join(root, 'stale.lock');
    fs.writeFileSync(staleLock, JSON.stringify({ pid: 99999999, startedAt: 1 }));
    await acquireHermesBuildLock(staleLock, { isProcessAlive: () => false, wait: async () => undefined });
    expect(JSON.parse(fs.readFileSync(staleLock, 'utf8')).pid).toBe(process.pid);

    const liveLock = path.join(root, 'live.lock');
    fs.writeFileSync(liveLock, JSON.stringify({ pid: 2, startedAt: 1 }));
    let time = 0;
    await expect(
        acquireHermesBuildLock(liveLock, {
            timeoutMs: 250,
            isProcessAlive: () => true,
            now: () => time,
            wait: async (delay) => {
                time += delay;
            }
        })
    ).rejects.toThrow(`Timed out waiting for Hermes build lock: ${liveLock}`);
});

function temporaryDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-source-patch-'));
    directories.push(directory);
    return directory;
}

function writePatch(directory: string, name: string, filename: string): void {
    fs.writeFileSync(
        path.join(directory, name),
        `diff --git a/${filename} b/${filename}\n--- a/${filename}\n+++ b/${filename}\n@@ -1 +1 @@\n-old\n+new\n`
    );
}

function isPorcelainStatusCommand(args: readonly string[]): boolean {
    return args.some((argument) => argument.startsWith('--porcelain'));
}
