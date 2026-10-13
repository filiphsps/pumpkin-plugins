import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

const script = path.resolve(import.meta.dirname, 'test-external-consumer.mjs');

test('removes the temporary workspace when package packing fails', (t) => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-external-consumer-test-'));
    t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const tempDirectory = path.join(fixtureRoot, 'tmp');
    fs.mkdirSync(tempDirectory);

    const packageManagerPath = path.join(fixtureRoot, 'pnpm.cjs');
    fs.writeFileSync(
        packageManagerPath,
        `if (process.argv[2] === '--version') console.log('12.10.1');
else if (process.argv[2] === 'pack') { console.error('forced pack failure'); process.exit(1); }
else process.exit(2);\n`
    );
    const nodeVersionOverridePath = path.join(fixtureRoot, 'node-version.cjs');
    fs.writeFileSync(nodeVersionOverridePath, "Object.defineProperty(process, 'version', { value: 'v24.21.0' });\n");

    const result = spawnSync(process.execPath, ['--require', nodeVersionOverridePath, script], {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: {
            ...process.env,
            npm_execpath: packageManagerPath,
            TMPDIR: tempDirectory
        },
        encoding: 'utf8'
    });

    assert.notEqual(
        result.status,
        0,
        `Expected the forced package packing failure:\n${result.stdout}\n${result.stderr}`
    );
    assert.match(result.stderr, /forced pack failure/);
    assert.deepEqual(fs.readdirSync(tempDirectory), []);
});
