import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { nodeVersion } from './utils/tool-packages.mjs';

const script = path.resolve(import.meta.dirname, 'test-external-consumer.mjs');
const requiredPnpmVersion = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8'))
    .devEngines.packageManager.version;
const pinnedNodeVersion = `v${nodeVersion()}`;
const laterNodeVersion = `v${Number(nodeVersion().split('.')[0]) + 1}.0.0`;

test('accepts a later Node version before handling a package packing failure', (t) => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-external-consumer-test-'));
    t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const tempDirectory = path.join(fixtureRoot, 'tmp');
    fs.mkdirSync(tempDirectory);

    const packageManagerPath = path.join(fixtureRoot, 'pnpm.cjs');
    fs.writeFileSync(
        packageManagerPath,
        `if (process.argv[2] === '--version') console.log('${requiredPnpmVersion}');
else if (process.argv[2] === 'pack') { console.error('forced pack failure'); process.exit(1); }
else process.exit(2);\n`,
    );
    const nodeVersionOverridePath = path.join(fixtureRoot, 'node-version.cjs');
    fs.writeFileSync(
        nodeVersionOverridePath,
        `Object.defineProperty(process, 'version', { value: '${laterNodeVersion}' });\n`,
    );

    const result = spawnSync(process.execPath, ['--require', nodeVersionOverridePath, script], {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: {
            ...process.env,
            npm_execpath: packageManagerPath,
            TMPDIR: tempDirectory,
        },
        encoding: 'utf8',
    });

    assert.notEqual(
        result.status,
        0,
        `Expected the forced package packing failure:\n${result.stdout}\n${result.stderr}`,
    );
    assert.match(result.stderr, /forced pack failure/);
    assert.deepEqual(fs.readdirSync(tempDirectory), []);
});

test('preserves configured external-consumer caches when the temporary workspace is removed', (t) => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-external-consumer-test-'));
    t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const tempDirectory = path.join(fixtureRoot, 'tmp');
    const pnpmStoreDirectory = path.join(fixtureRoot, 'pnpm-store');
    const hermesCacheDirectory = path.join(fixtureRoot, 'hermes-cache');
    fs.mkdirSync(tempDirectory);

    const packageManagerPath = path.join(fixtureRoot, 'pnpm.cjs');
    fs.writeFileSync(
        packageManagerPath,
        `if (process.argv[2] === '--version') console.log('${requiredPnpmVersion}');
else if (process.argv[2] === 'pack') { console.error('forced pack failure'); process.exit(1); }
else process.exit(2);\n`,
    );
    const nodeVersionOverridePath = path.join(fixtureRoot, 'node-version.cjs');
    fs.writeFileSync(
        nodeVersionOverridePath,
        `Object.defineProperty(process, 'version', { value: '${pinnedNodeVersion}' });\n`,
    );

    const result = spawnSync(process.execPath, ['--require', nodeVersionOverridePath, script], {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: {
            ...process.env,
            npm_execpath: packageManagerPath,
            TMPDIR: tempDirectory,
            PUMPKIN_EXTERNAL_CONSUMER_PNPM_STORE_DIR: pnpmStoreDirectory,
            STATIC_HERMES_CACHE_DIR: hermesCacheDirectory,
        },
        encoding: 'utf8',
    });

    assert.notEqual(
        result.status,
        0,
        `Expected the forced package packing failure:\n${result.stdout}\n${result.stderr}`,
    );
    assert.match(result.stderr, /forced pack failure/);
    assert.equal(fs.statSync(pnpmStoreDirectory).isDirectory(), true);
    assert.equal(fs.statSync(hermesCacheDirectory).isDirectory(), true);
    assert.deepEqual(fs.readdirSync(tempDirectory), []);
});
