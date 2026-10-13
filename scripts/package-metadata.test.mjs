import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

const script = path.resolve(import.meta.dirname, 'package-metadata.mjs');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-metadata-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'packages'));
    fs.mkdirSync(path.join(root, 'tools'));
    fs.writeFileSync(path.join(root, 'LICENSE'), 'MIT');
    const file = path.join(root, 'package.json');
    fs.writeFileSync(file, JSON.stringify({ name: 'fixture', description: 'Test metadata' }));
    const run = (...args) =>
        spawnSync(process.execPath, [script, ...args], {
            env: { ...process.env, PUMPKIN_PLUGINS_ROOT: root },
            encoding: 'utf8'
        });
    assert.equal(run('--fix').status, 0);
    return { root, file, run };
}
test('rejects escaped author and contributor names and fixes them to literal UTF-8', (t) => {
    const { file, run } = fixture(t);
    const original = fs.readFileSync(file, 'utf8');
    for (const unicodeEscape of ['\\u00f6', '\\u00F6']) {
        fs.writeFileSync(file, original.replaceAll('ö', unicodeEscape));
        const result = run();
        assert.equal(result.status, 1);
        assert.match(result.stderr, /package\.json:.*literal UTF-8/);
        assert.equal(run('--fix').status, 0);
        assert.equal(fs.readFileSync(file, 'utf8'), original);
        assert.equal(run().status, 0);
    }
});
test('permits literal backslash sequences and necessary JSON control escapes', (t) => {
    const { file, run } = fixture(t);
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    pkg.example = 'literal \\u00f6\n\t';
    fs.writeFileSync(file, `${JSON.stringify(pkg, null, 4)}\n`);
    assert.equal(run().status, 0);
});

test('does not package a source bin directory when the CLI is compiled under dist', (t) => {
    const { root, run } = fixture(t);
    const runtime = path.join(root, 'tools/static-hermes-runtime');
    fs.mkdirSync(runtime, { recursive: true });
    const manifest = path.join(runtime, 'package.json');
    fs.writeFileSync(
        manifest,
        JSON.stringify({
            name: '@pumpkin-plugins/static-hermes-runtime',
            description: 'Static Hermes runtime',
            exports: { '.': './src/index.ts' },
            bin: { 'static-hermes-runtime': 'dist/cli.js' }
        })
    );

    assert.equal(run('--fix').status, 0);

    const files = JSON.parse(fs.readFileSync(manifest, 'utf8')).files;
    assert.deepEqual(files, [
        'src',
        'dist',
        'cmake',
        'hermes-patches',
        'hermes-source.lock.json',
        'toolchain-versions.json',
        'wasi-sdk.lock.json',
        'native',
        'README.md'
    ]);
});
