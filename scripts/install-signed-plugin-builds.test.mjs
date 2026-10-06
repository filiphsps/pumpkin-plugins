import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { signWasm, verifyWasm } from '../tools/signing/src/index.ts';
import { customSection } from '../tools/signing/src/wasm.ts';

const script = path.resolve(import.meta.dirname, 'install-signed-plugin-builds.mjs');
const seed = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const dirs = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(signedArtifact) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signed-plugin-builds-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, 'packages/example/build'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'packages/example/package.json'),
        JSON.stringify({ pumpkinPlugin: { output: 'build/example.wasm' } })
    );
    const original = Buffer.concat([
        Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
        customSection('name', Buffer.from('fixture'))
    ]);
    const signed = signWasm(
        original,
        {
            marketplace_url: '',
            plugin_id: 0,
            plugin_name: 'Example',
            version: '1.2.3',
            dev_id: 0,
            dev_name: 'Test Developer',
            is_paid: false,
            user_id: 0,
            license_key: null,
            issued_at: '2026-10-06T00:00:00.000Z'
        },
        seed
    );
    fs.writeFileSync(path.join(root, 'packages/example/build/example.wasm'), original);
    fs.writeFileSync(path.join(root, 'dist/example.wasm'), signedArtifact ? signed : original);
    return { root, original, signed };
}

function run(root) {
    const result = spawnSync(process.execPath, [script], {
        env: { ...process.env, PUMPKIN_PLUGINS_ROOT: root },
        encoding: 'utf8'
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('install-signed-plugin-builds', () => {
    it('installs verified signed collection artifacts for integration tests', () => {
        const { root, signed } = fixture(true);

        const result = run(root);
        assert.equal(result.status, 0, result.output);
        const built = fs.readFileSync(path.join(root, 'packages/example/build/example.wasm'));
        assert.deepEqual(built, signed);
        assert.equal(verifyWasm(built).valid, true);
    });

    it('rejects unsigned collection artifacts without changing package builds', () => {
        const { root, original } = fixture(false);

        const result = run(root);
        assert.equal(result.status, 1);
        assert.match(result.output, /failed verification/);
        assert.deepEqual(fs.readFileSync(path.join(root, 'packages/example/build/example.wasm')), original);
    });
});
