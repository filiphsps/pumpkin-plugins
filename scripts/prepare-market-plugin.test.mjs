import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { customSection, signWasm, verifyWasm } from '../tools/signing/src/index.ts';

const root = path.resolve(import.meta.dirname, '..');
const script = path.join(root, 'scripts', 'prepare-market-plugin.mjs');
const seed = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const metadata = {
    marketplace_url: '',
    plugin_id: 0,
    plugin_name: 'Example',
    version: '1.2.3',
    dev_id: 0,
    dev_name: 'Test Developer',
    is_paid: false,
    user_id: 0,
    license_key: null,
    issued_at: '2026-10-08T00:00:00.000Z'
};
const component = Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00]),
    customSection('fixture', Buffer.from('component'))
]);
const dirs = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(wasm) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-market-plugin-'));
    dirs.push(dir);
    const file = path.join(dir, 'example.wasm');
    fs.writeFileSync(file, wasm);
    return file;
}

function run(file, pluginName = metadata.plugin_name, version = metadata.version) {
    return spawnSync(process.execPath, [script, file, pluginName, version], {
        cwd: root,
        encoding: 'utf8'
    });
}

describe('prepare-market-plugin', () => {
    it('verifies the signed release artifact and replaces it with the unsigned component for Market', () => {
        const signed = signWasm(component, metadata, seed);
        const file = fixture(signed);

        const result = run(file);

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Prepared unsigned Market component/);
        const uploaded = fs.readFileSync(file);
        assert.deepEqual(uploaded, component);
        assert.equal(verifyWasm(uploaded).signed, false);
    });

    it('rejects a mismatched release identity without changing the signed artifact', () => {
        const signed = signWasm(component, metadata, seed);
        const file = fixture(signed);

        const result = run(file, metadata.plugin_name, '9.9.9');

        assert.equal(result.status, 1);
        assert.match(result.stderr, /version .* does not match/);
        assert.deepEqual(fs.readFileSync(file), signed);
    });

    it('rejects an unsigned artifact without changing it', () => {
        const file = fixture(component);

        const result = run(file);

        assert.equal(result.status, 1);
        assert.match(result.stderr, /failed verification: no signature found/);
        assert.deepEqual(fs.readFileSync(file), component);
    });
});
