import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startPumpkin } from './instance.ts';

const made: string[] = [];
const realBinary = process.env.PUMPKIN_BIN;
const realLogDir = process.env.PUMPKIN_TEST_LOG_DIR;
const realKeepDir = process.env.PUMPKIN_KEEP_DIR;
const realRustLog = process.env.RUST_LOG;

afterEach(() => {
    if (realBinary === undefined) delete process.env.PUMPKIN_BIN;
    else process.env.PUMPKIN_BIN = realBinary;
    if (realLogDir === undefined) delete process.env.PUMPKIN_TEST_LOG_DIR;
    else process.env.PUMPKIN_TEST_LOG_DIR = realLogDir;
    if (realKeepDir === undefined) delete process.env.PUMPKIN_KEEP_DIR;
    else process.env.PUMPKIN_KEEP_DIR = realKeepDir;
    if (realRustLog === undefined) delete process.env.RUST_LOG;
    else process.env.RUST_LOG = realRustLog;
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Points `PUMPKIN_BIN` at a stand-in for the server binary that reports its Bedrock port as taken
 * on its first `failures` runs and comes up after that, the way a real one does when something else
 * took the port. Every run appends its number and the port it was given to a file of its own.
 * @param failures - How many runs should report the port as taken.
 * @param errorLines - Extra server errors to print after startup.
 * @param printRustLog - Whether to print the child's `RUST_LOG` value.
 * @returns A reader for the Java port each run was given.
 */
function fakePumpkin(failures: number, errorLines: string[] = [], printRustLog = false): () => string[] {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-pumpkin-'));
    made.push(dir);
    const file = path.join(dir, 'runs');
    fs.writeFileSync(
        path.join(dir, 'fake-pumpkin.mjs'),
        `#!/usr/bin/env node
import * as fs from 'node:fs';
const file = ${JSON.stringify(file)};
if (${printRustLog}) console.log('fake RUST_LOG=' + process.env.RUST_LOG);
const seen = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\\n').filter(Boolean) : [];
const count = seen.length + 1;
const port = fs.readFileSync('pumpkin.toml', 'utf8').match(/127\\.0\\.0\\.1:(\\d+)/)?.[1];
fs.appendFileSync(file, count + ':' + port + '\\n');
if (count <= ${failures}) {
    console.error('ERROR Failed to bind the Bedrock UDP socket on 127.0.0.1:' + port + ': Address already in use (os error 98)');
    process.exit(1);
}
for (const line of ${JSON.stringify(errorLines)}) console.error(line);
console.log('Server is now running');
process.stdin.once('data', () => process.exit(0));
process.stdin.resume();
`,
        { mode: 0o755 },
    );
    process.env.PUMPKIN_BIN = path.join(dir, 'fake-pumpkin.mjs');
    return () =>
        fs
            .readFileSync(file, 'utf8')
            .trim()
            .split('\n')
            .map((run) => run.split(':')[1]);
}

/** Runs unsafe process failures behind an external timeout and an isolated temp root. */
function failureProbe(kind: 'EACCES' | 'interpreter' | 'early exit' | 'stdin') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-failure-probe-'));
    made.push(dir);
    const temp = path.join(dir, 'temp');
    const logs = path.join(dir, 'logs');
    fs.mkdirSync(temp);
    const binary = path.join(dir, 'pumpkin');
    const source =
        kind === 'interpreter'
            ? '#!/no/such/pumpkin-interpreter\n'
            : `#!/usr/bin/env node
${kind === 'early exit' ? "console.error('fixture early exit'); process.exit(7);" : "console.log('Server is now running'); process.stdin.once('data', () => process.exit(0)); process.stdin.resume();"}
`;
    fs.writeFileSync(binary, source, { mode: kind === 'EACCES' ? 0o644 : 0o755 });
    const module = pathToFileURL(path.join(import.meta.dirname, 'instance.ts')).href;
    const program = `
import { startPumpkin } from ${JSON.stringify(module)};
let server;
try {
    server = await startPumpkin({ name: 'failure-probe', readyTimeoutMs: 3_000 });
    if (${JSON.stringify(kind)} !== 'stdin') throw new Error('unexpected readiness');
    setImmediate(() => {
        server.child.stdin.emit('error', new Error('fixture stdin failure'));
        server.command('list');
    });
    await server.waitForLog(/never emitted/, 500);
    throw new Error('unexpected log');
} catch (error) {
    console.log('PROBE_FAILURE=' + error.message);
} finally {
    if (server) await Promise.all([server.stop(), server.stop()]);
}
`;
    const result = spawnSync(
        process.execPath,
        ['--experimental-transform-types', '--input-type=module', '--eval', program],
        {
            env: {
                ...process.env,
                TMPDIR: temp,
                PUMPKIN_BIN: binary,
                PUMPKIN_TEST_LOG_DIR: logs,
                PUMPKIN_KEEP_DIR: '',
            },
            encoding: 'utf8',
            timeout: 6000,
        },
    );
    return { result, leftovers: fs.readdirSync(temp), logs: fs.existsSync(logs) ? fs.readdirSync(logs) : [] };
}

function isRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Starts a server from a separate test process, ends that process with a signal and reports
 * whether the server outlived it. The stand-in server ignores stdin closing, like Pumpkin does.
 * @param signal - The signal that ends the test process.
 */
async function signalProbe(signal: 'SIGINT' | 'SIGTERM') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-signal-probe-'));
    made.push(dir);
    const temp = path.join(dir, 'temp');
    fs.mkdirSync(temp);
    const pidFile = path.join(dir, 'server.pid');
    const binary = path.join(dir, 'pumpkin');
    fs.writeFileSync(
        binary,
        `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
console.log('Server is now running');
setInterval(() => {}, 1000);
`,
        { mode: 0o755 },
    );
    const module = pathToFileURL(path.join(import.meta.dirname, 'instance.ts')).href;
    const program = `
import { startPumpkin } from ${JSON.stringify(module)};
await startPumpkin({ readyTimeoutMs: 3_000 });
console.log('PROBE_READY');
setInterval(() => {}, 1000);
`;
    const probe = spawn(
        process.execPath,
        ['--experimental-transform-types', '--input-type=module', '--eval', program],
        {
            env: { ...process.env, TMPDIR: temp, PUMPKIN_BIN: binary, PUMPKIN_KEEP_DIR: '', PUMPKIN_TEST_LOG_DIR: '' },
            stdio: ['ignore', 'pipe', 'inherit'],
        },
    );
    let serverPid: number | undefined;
    try {
        probe.stdout.setEncoding('utf8');
        for await (const chunk of probe.stdout) if (String(chunk).includes('PROBE_READY')) break;
        serverPid = Number(fs.readFileSync(pidFile, 'utf8'));
        const exited = once(probe, 'exit');
        probe.kill(signal);
        const [, exitSignal] = (await exited) as [number | null, NodeJS.Signals | null];
        const deadline = Date.now() + 3_000;
        while (isRunning(serverPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        return { exitSignal, serverOutlived: isRunning(serverPid) };
    } finally {
        probe.kill('SIGKILL');
        if (serverPid !== undefined && isRunning(serverPid)) process.kill(serverPid, 'SIGKILL');
    }
}

describe('startPumpkin', () => {
    it.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGTERM'] as const)(
        'stops its servers when the test process is ended by %s',
        async (signal) => {
            const probe = await signalProbe(signal);
            expect(probe.serverOutlived).toBe(false);
            expect(probe.exitSignal).toBe(signal);
        },
        10_000,
    );

    it.each([
        ['EACCES', /EACCES/],
        ['interpreter', /ENOENT/],
        ['early exit', /exited before.*\n.*fixture early exit/s],
        ['stdin', /fixture stdin failure/],
    ] as const)(
        'settles %s failures and cleans its directory without an unhandled event',
        (kind, reason) => {
            const probe = failureProbe(kind);
            expect(probe.result.error, probe.result.stderr).toBeUndefined();
            expect(probe.result.status, probe.result.stderr).toBe(0);
            expect(probe.result.stdout).toMatch(reason);
            expect(probe.result.stderr).not.toContain('Unhandled');
            expect(probe.leftovers).toEqual([]);
            expect(probe.logs).toHaveLength(1);
        },
        10_000,
    );

    it('coalesces concurrent and repeated stop calls into one shutdown', async () => {
        fakePumpkin(0);
        const server = await startPumpkin();
        const child = Reflect.get(server, 'child') as ChildProcessWithoutNullStreams;
        const write = vi.spyOn(child.stdin, 'write');
        await Promise.all([server.stop(), server.stop()]);
        await server.stop();
        expect(write.mock.calls).toEqual([['stop\n']]);
        expect(fs.existsSync(server.dir)).toBe(false);
    });

    it('removes the server directory even when saving its log fails', async () => {
        fakePumpkin(0);
        const server = await startPumpkin();
        made.push(server.dir);
        const blocked = path.join(server.dir, 'not-a-log-directory');
        fs.writeFileSync(blocked, 'file');
        process.env.PUMPKIN_TEST_LOG_DIR = blocked;
        delete process.env.PUMPKIN_KEEP_DIR;
        await expect(server.stop()).rejects.toThrow();
        expect(fs.existsSync(server.dir)).toBe(false);
    });

    it('keeps INFO readiness logs visible when the parent filters them out', async () => {
        process.env.RUST_LOG = 'warn';
        fakePumpkin(0, [], true);

        const server = await startPumpkin();
        try {
            expect(server.logs()).toContain('fake RUST_LOG=info');
        } finally {
            await server.stop();
        }
    });

    it('passes a requested log level to the server, for tests that wait on debug logs', async () => {
        fakePumpkin(0, [], true);

        const server = await startPumpkin({ logLevel: 'debug' });
        try {
            expect(server.logs()).toContain('fake RUST_LOG=debug');
        } finally {
            await server.stop();
        }
    });

    it('starts again on other ports when the server loses one to another process', async () => {
        const ports = fakePumpkin(1);
        const server = await startPumpkin({ name: 'port-taken' });
        await server.stop();

        expect(ports()).toHaveLength(2);
        expect(new Set(ports()).size).toBe(2);
    });

    it('gives up instead of starting servers forever when the port is never free', async () => {
        const ports = fakePumpkin(99);
        const error: unknown = await startPumpkin({ name: 'never-free' }).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/exited before/);
        expect(ports()).toHaveLength(3);
    });

    it('filters the known baseline error but exposes other server errors', async () => {
        fakePumpkin(0, ['ERROR Failed to save level.dat: Info not found!', 'ERROR Plugin failed to load']);
        const server = await startPumpkin();
        try {
            await server.waitForLog(/Plugin failed to load/);
            expect(server.errors()).toEqual(['ERROR Plugin failed to load']);
        } finally {
            await server.stop();
        }
    });

    it('saves a named log before removing the temporary server directory', async () => {
        const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-test-logs-'));
        made.push(logDir);
        process.env.PUMPKIN_TEST_LOG_DIR = logDir;
        delete process.env.PUMPKIN_KEEP_DIR;
        fakePumpkin(0);

        const server = await startPumpkin({ name: 'plugin test' });
        const dir = server.dir;
        try {
            await server.waitForLog(/Server is now running/);
        } finally {
            await server.stop();
        }

        const [savedName] = fs.readdirSync(logDir);
        expect(savedName).toBe(`plugin_test-${path.basename(dir)}.log`);
        expect(fs.readFileSync(path.join(logDir, savedName ?? ''), 'utf8')).toContain('Server is now running');
        expect(fs.existsSync(dir)).toBe(false);
    });

    it('keeps the temporary server directory when requested', async () => {
        delete process.env.PUMPKIN_TEST_LOG_DIR;
        process.env.PUMPKIN_KEEP_DIR = '1';
        fakePumpkin(0);

        const server = await startPumpkin();
        const dir = server.dir;
        made.push(dir);
        try {
            await server.waitForLog(/Server is now running/);
        } finally {
            await server.stop();
        }

        expect(fs.existsSync(dir)).toBe(true);
    });
});
