import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolvePumpkinBinary } from './binary.ts';
import { LogBuffer } from './log-buffer.ts';
import { prepareServerDir, type ServerDir, type ServerDirOptions } from './server-dir.ts';

/** Options for `startPumpkin`. */
export interface StartOptions extends ServerDirOptions {
    /** Used in the saved log file name when PUMPKIN_TEST_LOG_DIR is set. */
    name?: string;
    /** How long to wait for the server to finish starting. Default 90 s. */
    readyTimeoutMs?: number;
}

const READY = /Server is now running/;

// A port is free when the harness picks it and again when the server binds it, and something else on
// the machine may take it in between. That is nobody else's doing, so a server that starts and then
// finds a port taken is started again on ports of its own.
const PORT_TAKEN = /Address already in use/;
/** How many times a server is started before the start is failed. */
const START_ATTEMPTS = 3;

// Errors Pumpkin 0.2.0 logs on every first start of an empty server directory, with or
// without plugins. Ignored by errors() so tests only fail on new problems.
const BASELINE_ERRORS = [/Failed to save level\.dat: Info not found!/];
const children = new Set<ChildProcessWithoutNullStreams>();

// A crashed or interrupted test run must not leave servers holding ports.
process.once('exit', () => {
    for (const child of children) child.kill('SIGKILL');
});

/** A running Pumpkin server in a temporary directory. Start one with `startPumpkin`. */
export class PumpkinInstance {
    private readonly log = new LogBuffer();
    private readonly exited: Promise<number | null>;
    private hasExited = false;

    private constructor(
        private readonly child: ChildProcessWithoutNullStreams,
        private readonly server: ServerDir,
        private readonly name: string
    ) {
        children.add(child);
        this.exited = new Promise((resolve) => {
            child.once('exit', (code) => {
                this.hasExited = true;
                children.delete(child);
                this.log.notify();
                resolve(code);
            });
        });
        this.log.attach(child.stdout);
        this.log.attach(child.stderr);
    }

    /**
     * Starts a server and waits until it is running.
     * @param options - What to put in its directory and how to name its log.
     * @returns The running server.
     * @throws {Error} When it doesn't start in time, or keeps losing its port to another process.
     * The server is stopped first.
     */
    static async start(options: StartOptions = {}): Promise<PumpkinInstance> {
        const bin = await resolvePumpkinBinary();
        for (let attempt = 1; ; attempt++) {
            const server = await prepareServerDir(options);
            const child = spawn(bin, [], {
                cwd: server.dir,
                stdio: 'pipe',
                // Tests use INFO startup and plugin logs as observable readiness and behavior signals.
                env: { ...process.env, RUST_LOG: 'info' }
            });
            const instance = new PumpkinInstance(child, server, options.name ?? 'pumpkin');
            try {
                await instance.waitForLog(READY, options.readyTimeoutMs ?? 90_000);
                return instance;
            } catch (err) {
                await instance.stop();
                if (attempt < START_ATTEMPTS && PORT_TAKEN.test(instance.logs())) continue;
                throw err;
            }
        }
    }

    /** The server's temporary directory. */
    get dir(): string {
        return this.server.dir;
    }

    /** The port the Java edition listens on. */
    get javaPort(): number {
        return this.server.javaPort;
    }

    /** The port the Bedrock edition listens on. */
    get bedrockPort(): number {
        return this.server.bedrockPort;
    }

    /** Every log line so far, without color codes. */
    get lines(): string[] {
        return this.log.lines;
    }

    /**
     * Where Pumpkin keeps a plugin's private data.
     * @param pluginName - The plugin's name.
     * @returns The folder on disk.
     */
    pluginDataDir(pluginName: string): string {
        return path.join(this.dir, 'plugins', 'data', pluginName);
    }

    /**
     * All log output.
     * @returns Every line joined with newlines.
     */
    logs(): string {
        return this.log.text();
    }

    /**
     * ERROR log lines, minus the known first-start baseline.
     * @returns The lines.
     */
    errors(): string[] {
        return this.lines.filter((l) => /\bERROR\b/.test(l) && !BASELINE_ERRORS.some((b) => b.test(l)));
    }

    /**
     * Waits for a log line.
     * @param pattern - What to look for.
     * @param timeoutMs - How long to wait.
     * @param fromIndex - Only consider lines from this index on, to ignore earlier output.
     * @returns The first matching line.
     * @throws {Error} When the server exits or the time runs out first.
     */
    waitForLog(pattern: RegExp, timeoutMs = 30_000, fromIndex = 0): Promise<string> {
        return this.log.waitFor(pattern, { timeoutMs, fromIndex, isOver: () => this.hasExited, process: 'Pumpkin' });
    }

    /**
     * Runs a console command.
     * @param text - The command, for example `list`.
     */
    command(text: string): void {
        this.child.stdin.write(`${text}\n`);
    }

    /** Stops the server (console `stop`, then SIGKILL after 20 s) and removes its directory. */
    async stop(): Promise<void> {
        if (!this.hasExited) {
            this.child.stdin.write('stop\n');
            const killer = setTimeout(() => this.child.kill('SIGKILL'), 20_000);
            await this.exited;
            clearTimeout(killer);
        }
        this.saveLog();
        if (process.env.PUMPKIN_KEEP_DIR) console.log(`Kept Pumpkin test directory: ${this.dir}`);
        else fs.rmSync(this.dir, { recursive: true, force: true });
    }

    private saveLog(): void {
        const logDir = process.env.PUMPKIN_TEST_LOG_DIR;
        if (!logDir) return;
        fs.mkdirSync(logDir, { recursive: true });
        const file = `${this.name}-${path.basename(this.dir)}.log`.replace(/[^\w.-]/g, '_');
        fs.writeFileSync(path.join(logDir, file), this.logs());
    }
}

/** Starts a Pumpkin server. Shorthand for `PumpkinInstance.start`. */
export const startPumpkin = PumpkinInstance.start;
