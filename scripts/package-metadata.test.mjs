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
    return { file, run };
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
