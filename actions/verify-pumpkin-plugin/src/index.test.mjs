import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { publicKeyOf, signWasm } from '../../../tools/signing/src/sign.ts';
import { METADATA, minimalWasm, SEED } from '../../../tools/signing/src/testing/fixtures.ts';

const actionRoot = path.resolve(import.meta.dirname, '..');
const entrypoint = path.join(actionRoot, 'src/index.mjs');
const tempDirs = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-pumpkin-plugin-'));
    tempDirs.push(dir);
    const wasmFile = path.join(dir, 'plugin.wasm');
    const signed = signWasm(minimalWasm(), METADATA, SEED);
    fs.writeFileSync(wasmFile, signed);
    return { dir, wasmFile, signed };
}

function run(dir, inputs = {}) {
    const outputFile = path.join(dir, 'github-output.txt');
    fs.writeFileSync(outputFile, '');
    const result = spawnSync(process.execPath, [entrypoint], {
        cwd: dir,
        env: {
            ...process.env,
            GITHUB_OUTPUT: outputFile,
            'INPUT_WASM-FILE': 'plugin.wasm',
            'INPUT_PLUGINS-MANIFEST': '',
            'INPUT_EXPECTED-PUBLIC-KEY': '',
            'INPUT_PLUGIN-NAME': '',
            INPUT_VERSION: '',
            ...inputs
        },
        encoding: 'utf8'
    });
    return {
        ok: result.status === 0,
        out: `${result.stdout}${result.stderr}`,
        outputs: fs.readFileSync(outputFile, 'utf8')
    };
}

describe('verify-pumpkin-plugin action', () => {
    it('verifies a signed file, checks expected metadata and writes outputs', () => {
        const { dir } = fixture();

        const result = run(dir, {
            'INPUT_EXPECTED-PUBLIC-KEY': publicKeyOf(SEED),
            'INPUT_PLUGIN-NAME': METADATA.plugin_name,
            INPUT_VERSION: METADATA.version
        });

        assert.ok(result.ok, result.out);
        assert.match(result.out, /Verified plugin\.wasm: demo 1\.2\.3/);
        assert.match(result.outputs, /verified-count<<.*\n1\n/);
        assert.match(result.outputs, /plugin-name<<.*\ndemo\n/);
        assert.match(result.outputs, /version<<.*\n1\.2\.3\n/);
        assert.match(result.outputs, /developer-name<<.*\nFiliph Sandström\n/);
        assert.match(result.outputs, new RegExp(`public-key<<.*\\n${publicKeyOf(SEED)}\\n`));
        assert.match(result.outputs, /issued-at<<.*\n2026-01-02T03:04:05\.000Z\n/);
    });

    it('verifies every file and checks plugin name and version from a manifest', () => {
        const { dir, signed } = fixture();
        fs.writeFileSync(path.join(dir, 'second.wasm'), signed);
        fs.writeFileSync(
            path.join(dir, 'plugins.json'),
            JSON.stringify([
                { 'plugin-name': METADATA.plugin_name, version: METADATA.version, 'wasm-file': 'plugin.wasm' },
                { 'plugin-name': METADATA.plugin_name, version: METADATA.version, 'wasm-file': 'second.wasm' }
            ])
        );

        const result = run(dir, {
            'INPUT_WASM-FILE': '',
            'INPUT_PLUGINS-MANIFEST': 'plugins.json',
            'INPUT_EXPECTED-PUBLIC-KEY': publicKeyOf(SEED)
        });

        assert.ok(result.ok, result.out);
        assert.match(result.out, /Verified 2 Pumpkin plugin file\(s\)\./);
        assert.match(result.outputs, /verified-count<<.*\n2\n/);
    });

    it('rejects unsigned files', () => {
        const { dir } = fixture();
        fs.writeFileSync(path.join(dir, 'plugin.wasm'), minimalWasm());

        const result = run(dir);

        assert.equal(result.ok, false);
        assert.match(result.out, /file is not signed/);
    });

    it('rejects tampered signatures', () => {
        const { dir, signed } = fixture();
        const tampered = Buffer.from(signed);
        tampered[11] ^= 0xff;
        fs.writeFileSync(path.join(dir, 'plugin.wasm'), tampered);

        const result = run(dir);

        assert.equal(result.ok, false);
        assert.match(result.out, /signature verification failed/);
    });

    it('rejects a valid signature from a different trusted key', () => {
        const { dir } = fixture();

        const result = run(dir, { 'INPUT_EXPECTED-PUBLIC-KEY': '0'.repeat(64) });

        assert.equal(result.ok, false);
        assert.match(result.out, /signature public key does not match expected-public-key/);
    });

    it('rejects plugin name or version mismatches', () => {
        const { dir } = fixture();

        const wrongName = run(dir, { 'INPUT_PLUGIN-NAME': 'OtherPlugin' });
        const wrongVersion = run(dir, { INPUT_VERSION: '9.9.9' });

        assert.equal(wrongName.ok, false);
        assert.match(wrongName.out, /plugin name is "demo", expected "OtherPlugin"/);
        assert.equal(wrongVersion.ok, false);
        assert.match(wrongVersion.out, /version is "1\.2\.3", expected "9\.9\.9"/);
    });

    it('requires exactly one verification mode and rejects malformed expected keys', () => {
        const { dir } = fixture();

        const noMode = run(dir, { 'INPUT_WASM-FILE': '' });
        const bothModes = run(dir, { 'INPUT_PLUGINS-MANIFEST': 'plugins.json' });
        const malformedKey = run(dir, { 'INPUT_EXPECTED-PUBLIC-KEY': 'not-a-key' });

        assert.equal(noMode.ok, false);
        assert.match(noMode.out, /Set exactly one of wasm-file or plugins-manifest/);
        assert.equal(bothModes.ok, false);
        assert.match(bothModes.out, /Set exactly one of wasm-file or plugins-manifest/);
        assert.equal(malformedKey.ok, false);
        assert.match(malformedKey.out, /expected-public-key must be/);
    });

    it('rejects manifest metadata that disagrees with the signed file', () => {
        const { dir } = fixture();
        fs.writeFileSync(
            path.join(dir, 'plugins.json'),
            JSON.stringify([{ 'plugin-name': 'OtherPlugin', version: METADATA.version, 'wasm-file': 'plugin.wasm' }])
        );

        const result = run(dir, { 'INPUT_WASM-FILE': '', 'INPUT_PLUGINS-MANIFEST': 'plugins.json' });

        assert.equal(result.ok, false);
        assert.match(result.out, /plugin name is "demo", expected "OtherPlugin"/);
    });
});
