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
    fs.writeFileSync(path.join(root, '.node-version'), '24.21.0\n');
    const file = path.join(root, 'package.json');
    fs.writeFileSync(
        file,
        JSON.stringify({
            name: 'fixture',
            description: 'Test metadata',
            repository: { type: 'git', url: 'git+https://example.test/team/fixture.git' },
        }),
    );
    const run = (...args) =>
        spawnSync(process.execPath, [script, ...args], {
            env: { ...process.env, PUMPKIN_PLUGINS_ROOT: root },
            encoding: 'utf8',
        });
    assert.equal(run('--fix').status, 0);
    return { root, file, run };
}
test('does not enforce or rewrite author and funding metadata', (t) => {
    const { file, run } = fixture(t);
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    pkg.author = 'Maintained by the community';
    pkg.funding = 'https://example.test/fund';
    fs.writeFileSync(file, `${JSON.stringify(pkg, null, 4)}\n`);

    assert.equal(run().status, 0);
    assert.equal(run('--fix').status, 0);

    const fixed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(fixed.author, 'Maintained by the community');
    assert.equal(fixed.funding, 'https://example.test/fund');
});

test('keeps the root repository field in its existing npm-supported form', (t) => {
    const { file, run } = fixture(t);
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    pkg.repository = 'https://example.test/team/fixture';
    fs.writeFileSync(file, `${JSON.stringify(pkg, null, 4)}\n`);

    assert.equal(run().status, 0);
    assert.equal(run('--fix').status, 0);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).repository, 'https://example.test/team/fixture');
});

test('uses the workspace Node pin for every public tool package', (t) => {
    const { root, run } = fixture(t);
    const packageDirectory = path.join(root, 'tools/example');
    const manifest = path.join(packageDirectory, 'package.json');
    fs.mkdirSync(packageDirectory, { recursive: true });
    fs.writeFileSync(
        manifest,
        JSON.stringify({
            name: 'example-tool',
            version: '1.0.0',
            description: 'A tool discovered from its manifest',
            publishConfig: { access: 'public' },
        }),
    );
    fs.writeFileSync(path.join(root, '.node-version'), '26.4.0\n');

    assert.equal(run('--fix').status, 0);

    const fixed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    assert.deepEqual(fixed.engines, { node: '>=26.4.0' });
    assert.equal(run().status, 0);
});

test('preserves package-specific publication contents when metadata is fixed', (t) => {
    const { root, run } = fixture(t);
    const manifest = path.join(root, 'tools/example/package.json');
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    const files = ['dist', 'templates/custom'];
    fs.writeFileSync(
        manifest,
        JSON.stringify({
            name: '@example/tool',
            version: '1.0.0',
            description: 'A public tool',
            publishConfig: { access: 'public' },
            files,
        }),
    );

    assert.equal(run('--fix').status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(manifest, 'utf8')).files, files);
    assert.equal(run().status, 0);
});
