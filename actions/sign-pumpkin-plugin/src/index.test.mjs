import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { verifyWasm } from '../../../tools/signing/src/sign.ts';
import { customSection } from '../../../tools/signing/src/wasm.ts';

const actionRoot = path.resolve(import.meta.dirname, '..');
const entrypoint = path.join(actionRoot, 'src/index.mjs');
const SEED = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const dirs = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-pumpkin-plugin-'));
    dirs.push(dir);
    const wasmFile = path.join(dir, 'plugin.wasm');
    const original = Buffer.concat([
        Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
        Buffer.from([0x01, 0x04, 0x01, 0x60, 0x00, 0x00]),
        customSection('name', Buffer.from('fixture')),
    ]);
    fs.writeFileSync(wasmFile, original);
    fs.writeFileSync(`${wasmFile}.sha256`, 'stale checksum\n');
    return { dir, wasmFile, original };
}

function run(dir, inputs = {}) {
    const result = spawnSync(process.execPath, [entrypoint], {
        cwd: dir,
        env: childEnv(dir, {
            'INPUT_PLUGIN-NAME': 'TestPlugin',
            INPUT_VERSION: '1.2.3',
            'INPUT_WASM-FILE': 'plugin.wasm',
            'INPUT_DEVELOPER-NAME': 'Test Developer',
            'INPUT_SIGNING-KEY': SEED,
            INPUT_WARN: 'false',
            ...inputs,
        }),
        encoding: 'utf8',
    });
    return { ok: result.status === 0, out: `${result.stdout}${result.stderr}` };
}

// Start from a minimal environment so the runner's own INPUT_* and GITHUB_* values can't reach the action.
// NODE_V8_COVERAGE stays so coverage runs still collect the child's coverage.
function childEnv(dir, env) {
    const base = { PATH: process.env.PATH, HOME: process.env.HOME };
    for (const name of ['SystemRoot', 'NODE_V8_COVERAGE']) if (process.env[name]) base[name] = process.env[name];
    return {
        ...base,
        GITHUB_OUTPUT: path.join(dir, 'unread-outputs.txt'),
        GITHUB_STEP_SUMMARY: path.join(dir, 'unread-summary.md'),
        ...env,
    };
}

function runBatch(dir, plugins) {
    fs.writeFileSync(path.join(dir, 'plugins.json'), JSON.stringify(plugins));
    return run(dir, {
        'INPUT_PLUGIN-NAME': '',
        INPUT_VERSION: '',
        'INPUT_WASM-FILE': '',
        'INPUT_PLUGINS-MANIFEST': 'plugins.json',
    });
}

describe('sign-pumpkin-plugin action', () => {
    it('signs and verifies the file and refreshes an adjacent checksum', () => {
        const { dir, wasmFile, original } = fixture();

        const result = run(dir);
        assert.ok(result.ok, result.out);
        const signed = fs.readFileSync(wasmFile);
        const verification = verifyWasm(signed);
        assert.ok(verification.valid, verification.error);
        assert.notDeepEqual(signed, original);
        assert.equal(verification.metadata?.plugin_name, 'TestPlugin');
        assert.equal(verification.metadata?.version, '1.2.3');
        assert.equal(verification.metadata?.dev_name, 'Test Developer');
        assert.equal(
            fs.readFileSync(`${wasmFile}.sha256`, 'utf8'),
            `${createHash('sha256').update(signed).digest('hex')}  plugin.wasm\n`,
        );
    });

    it('keeps untrusted plugin names and versions on one success-log line', () => {
        const { dir } = fixture();
        const pluginName = 'TestPlugin\n::error::injected';
        const version = '1.2.3\n::error::injected';

        const result = run(dir, { 'INPUT_PLUGIN-NAME': pluginName, INPUT_VERSION: version });

        assert.ok(result.ok, result.out);
        assert.match(
            result.out,
            /Signed TestPlugin%0A::error::injected 1\.2\.3%0A::error::injected with Ed25519 public key/,
        );
        assert.equal(result.out.trimEnd().split(/\r?\n/).length, 1);
    });

    it('signs every file listed in a plugins manifest', () => {
        const { dir, wasmFile, original } = fixture();
        const secondWasmFile = path.join(dir, 'second.wasm');
        fs.writeFileSync(secondWasmFile, original);
        fs.writeFileSync(`${secondWasmFile}.sha256`, 'stale checksum\n');
        fs.writeFileSync(
            path.join(dir, 'plugins.json'),
            JSON.stringify([
                { 'plugin-name': 'TestPlugin', version: '1.2.3', 'wasm-file': 'plugin.wasm' },
                { 'plugin-name': 'SecondPlugin', version: '4.5.6', 'wasm-file': 'second.wasm' },
            ]),
        );

        const result = run(dir, {
            'INPUT_PLUGIN-NAME': '',
            INPUT_VERSION: '',
            'INPUT_WASM-FILE': '',
            'INPUT_PLUGINS-MANIFEST': 'plugins.json',
        });

        assert.ok(result.ok, result.out);
        for (const [file, expectedName, expectedVersion] of [
            [wasmFile, 'TestPlugin', '1.2.3'],
            [secondWasmFile, 'SecondPlugin', '4.5.6'],
        ]) {
            const signed = fs.readFileSync(file);
            const verification = verifyWasm(signed);
            assert.ok(verification.valid, verification.error);
            assert.equal(verification.metadata?.plugin_name, expectedName);
            assert.equal(verification.metadata?.version, expectedVersion);
            assert.equal(
                fs.readFileSync(`${file}.sha256`, 'utf8'),
                `${createHash('sha256').update(signed).digest('hex')}  ${path.basename(file)}\n`,
            );
        }
    });

    it('rejects invalid manifest entries without changing the files', () => {
        const { dir, wasmFile, original } = fixture();
        const checksumFile = `${wasmFile}.sha256`;
        const originalChecksum = fs.readFileSync(checksumFile);

        const result = runBatch(dir, [
            { 'plugin-name': 'TestPlugin', version: '1.2.3', 'wasm-file': 'plugin.wasm' },
            {},
        ]);

        assert.equal(result.ok, false);
        assert.match(result.out, /must include string plugin-name, version, and wasm-file fields/);
        assert.deepEqual(fs.readFileSync(wasmFile), original);
        assert.deepEqual(fs.readFileSync(checksumFile), originalChecksum);
    });

    it('does not change earlier artifacts when a later manifest file is missing', () => {
        const { dir, wasmFile, original } = fixture();
        const checksumFile = `${wasmFile}.sha256`;
        const originalChecksum = fs.readFileSync(checksumFile);

        const result = runBatch(dir, [
            { 'plugin-name': 'TestPlugin', version: '1.2.3', 'wasm-file': 'plugin.wasm' },
            { 'plugin-name': 'MissingPlugin', version: '4.5.6', 'wasm-file': 'missing.wasm' },
        ]);

        assert.equal(result.ok, false);
        assert.match(result.out, /WASM file not found/);
        assert.deepEqual(fs.readFileSync(wasmFile), original);
        assert.deepEqual(fs.readFileSync(checksumFile), originalChecksum);
    });

    it('does not change earlier artifacts when a later manifest file is malformed', () => {
        const { dir, wasmFile, original } = fixture();
        const checksumFile = `${wasmFile}.sha256`;
        const originalChecksum = fs.readFileSync(checksumFile);
        fs.writeFileSync(path.join(dir, 'malformed.wasm'), 'not a wasm file');

        const result = runBatch(dir, [
            { 'plugin-name': 'TestPlugin', version: '1.2.3', 'wasm-file': 'plugin.wasm' },
            { 'plugin-name': 'MalformedPlugin', version: '4.5.6', 'wasm-file': 'malformed.wasm' },
        ]);

        assert.equal(result.ok, false);
        assert.match(result.out, /not a WebAssembly/);
        assert.deepEqual(fs.readFileSync(wasmFile), original);
        assert.deepEqual(fs.readFileSync(checksumFile), originalChecksum);
    });

    it('fails on an empty key by default without changing the file', () => {
        const { dir, wasmFile, original } = fixture();

        const result = run(dir, { 'INPUT_SIGNING-KEY': '' });
        assert.equal(result.ok, false);
        assert.match(result.out, /signing-key input is empty/);
        assert.deepEqual(fs.readFileSync(wasmFile), original);
    });

    it('warns and leaves the file unchanged when an empty key is explicitly optional', () => {
        const { dir, wasmFile, original } = fixture();

        const result = run(dir, { 'INPUT_SIGNING-KEY': '', INPUT_WARN: 'true' });
        assert.ok(result.ok, result.out);
        assert.match(result.out, /::warning title=Plugin is unsigned::/);
        assert.deepEqual(fs.readFileSync(wasmFile), original);
    });

    it('rejects a malformed key without changing the file', () => {
        const { dir, wasmFile, original } = fixture();

        const result = run(dir, { 'INPUT_SIGNING-KEY': 'not-a-key', INPUT_WARN: 'true' });
        assert.equal(result.ok, false);
        assert.match(result.out, /invalid signing key/);
        assert.deepEqual(fs.readFileSync(wasmFile), original);
    });

    it('rejects a non-WASM file without changing it', () => {
        const { dir, wasmFile } = fixture();
        fs.writeFileSync(wasmFile, 'not a wasm file');

        const result = run(dir);
        assert.equal(result.ok, false);
        assert.match(result.out, /not a WebAssembly/);
        assert.equal(fs.readFileSync(wasmFile, 'utf8'), 'not a wasm file');
    });
});
