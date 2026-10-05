import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startPumpkin } from './instance.ts';

const made: string[] = [];
const realBinary = process.env.PUMPKIN_BIN;

afterEach(() => {
    if (realBinary === undefined) delete process.env.PUMPKIN_BIN;
    else process.env.PUMPKIN_BIN = realBinary;
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Points `PUMPKIN_BIN` at a stand-in for the server binary that reports its Bedrock port as taken
 * on its first `failures` runs and comes up after that, the way a real one does when something else
 * took the port. Every run appends its number and the port it was given to a file of its own.
 * @param failures - How many runs should report the port as taken.
 * @returns A reader for the Java port each run was given.
 */
function fakePumpkin(failures: number, errorLines: string[] = []): () => string[] {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-pumpkin-'));
    made.push(dir);
    const file = path.join(dir, 'runs');
    fs.writeFileSync(
        path.join(dir, 'fake-pumpkin.mjs'),
        `#!/usr/bin/env node
import * as fs from 'node:fs';
const file = ${JSON.stringify(file)};
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
        { mode: 0o755 }
    );
    process.env.PUMPKIN_BIN = path.join(dir, 'fake-pumpkin.mjs');
    return () =>
        fs
            .readFileSync(file, 'utf8')
            .trim()
            .split('\n')
            .map((run) => run.split(':')[1]);
}

describe('startPumpkin', () => {
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
});
