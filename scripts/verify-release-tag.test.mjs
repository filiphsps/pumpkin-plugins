import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, it } from 'node:test';

const script = path.join(import.meta.dirname, 'verify-release-tag.mjs');
const dirs = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const commit = 'c'.repeat(40);
const other = 'd'.repeat(40);

/** Runs the script with a fake `gh` that answers `gh api <endpoint>` from the given objects. */
function verify(tag, expected, objects) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-release-tag-'));
    dirs.push(dir);
    fs.writeFileSync(
        path.join(dir, 'gh'),
        `#!/usr/bin/env node
const objects = ${JSON.stringify(objects)};
const endpoint = process.argv[3].replace('repos/{owner}/{repo}/', '');
const object = objects[endpoint];
if (!object) {
    console.error('HTTP 404: Not Found');
    process.exit(1);
}
console.log(object);
`,
    );
    fs.chmodSync(path.join(dir, 'gh'), 0o755);
    return spawnSync('node', [script, tag, expected], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` },
    });
}

it('accepts a lightweight tag that points at the expected commit', () => {
    const result = verify('plugin-v1.0.0', commit, { 'git/ref/tags/plugin-v1.0.0': `commit ${commit}` });
    assert.equal(result.status, 0, result.stderr);
});

it('follows nested annotated tags to the commit', () => {
    const result = verify('plugin-v1.0.0', commit, {
        'git/ref/tags/plugin-v1.0.0': `tag ${'a'.repeat(40)}`,
        [`git/tags/${'a'.repeat(40)}`]: `tag ${'b'.repeat(40)}`,
        [`git/tags/${'b'.repeat(40)}`]: `commit ${commit}`,
    });
    assert.equal(result.status, 0, result.stderr);
});

it('rejects a tag that points at another commit', () => {
    const result = verify('plugin-v1.0.0', commit, {
        'git/ref/tags/plugin-v1.0.0': `tag ${'a'.repeat(40)}`,
        [`git/tags/${'a'.repeat(40)}`]: `commit ${other}`,
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, new RegExp(`::error::.*plugin-v1\\.0\\.0.*${other}.*${commit}`));
});

it('rejects a tag that names something other than a commit', () => {
    const result = verify('plugin-v1.0.0', commit, { 'git/ref/tags/plugin-v1.0.0': `tree ${commit}` });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /::error::/);
});

it('fails when GitHub has no such tag', () => {
    const result = verify('plugin-v1.0.0', commit, {});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /plugin-v1\.0\.0/);
});
