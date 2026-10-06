// Tests the release pin script against a throwaway repo. Run with `pnpm test:scripts`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const scripts = import.meta.dirname;
const dirs = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Writes a release-please config and plugin/action version files. Returns the path and a reader.
 */
function repo(versions, actionVersions = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unpin-'));
    dirs.push(dir);
    const packages = {};
    for (const [name, version] of Object.entries(versions)) {
        packages[`packages/${name}`] = { component: name, 'release-as': '0.0.1' };
        fs.mkdirSync(path.join(dir, 'packages', name), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'packages', name, 'package.json'),
            `${JSON.stringify({ name, version }, null, 4)}\n`
        );
    }
    for (const [name, version] of Object.entries(actionVersions)) {
        packages[`actions/${name}`] = { component: name, 'release-type': 'simple', 'release-as': '0.0.1' };
        fs.mkdirSync(path.join(dir, 'actions', name), { recursive: true });
        fs.writeFileSync(path.join(dir, 'actions', name, 'version.txt'), `${version}\n`);
    }
    const config = { 'release-type': 'node', packages };
    fs.writeFileSync(path.join(dir, 'release-please-config.json'), `${JSON.stringify(config, null, 4)}\n`);
    return { dir, read: () => JSON.parse(fs.readFileSync(path.join(dir, 'release-please-config.json'), 'utf8')) };
}

function run(dir) {
    const result = spawnSync('node', [path.join(scripts, 'unpin-release-as.mjs')], {
        env: { ...process.env, PUMPKIN_PLUGINS_ROOT: dir },
        encoding: 'utf8'
    });
    return { ok: result.status === 0, out: `${result.stdout}${result.stderr}` };
}

describe('unpin-release-as', () => {
    it('removes the pin from a plugin that has been released', () => {
        const { dir, read } = repo({ plug: '0.0.1' });
        const result = run(dir);
        assert.ok(result.ok, result.out);
        assert.deepEqual(read().packages['packages/plug'], { component: 'plug' });
        assert.match(result.out, /Removed "release-as" from packages\/plug \(at 0\.0\.1\)/);
    });

    it('removes the pin from a released action using its version.txt', () => {
        const { dir, read } = repo({}, { 'publish-action': '0.0.1' });
        const result = run(dir);
        assert.ok(result.ok, result.out);
        assert.deepEqual(read().packages['actions/publish-action'], {
            component: 'publish-action',
            'release-type': 'simple'
        });
        assert.match(result.out, /actions\/publish-action \(at 0\.0\.1\)/);
    });

    it('leaves the pin on a plugin still at its starting version', () => {
        const { dir, read } = repo({ released: '0.0.3', waiting: '0.0.0' });
        const result = run(dir);
        assert.ok(result.ok, result.out);
        assert.deepEqual(read().packages['packages/released'], { component: 'released' });
        assert.deepEqual(read().packages['packages/waiting'], {
            component: 'waiting',
            'release-as': '0.0.1'
        });
        assert.match(result.out, /No plugin is past its first release|packages\/released/);
    });

    it('leaves first-release pins on unreleased actions', () => {
        const { dir, read } = repo({}, { waiting: '0.0.0' });
        const result = run(dir);
        assert.ok(result.ok, result.out);
        assert.deepEqual(read().packages['actions/waiting'], {
            component: 'waiting',
            'release-type': 'simple',
            'release-as': '0.0.1'
        });
    });

    it('changes nothing when there is nothing to retire', () => {
        const { dir, read } = repo({ waiting: '0.0.0' });
        const before = fs.readFileSync(path.join(dir, 'release-please-config.json'), 'utf8');
        assert.ok(run(dir).ok);
        assert.equal(fs.readFileSync(path.join(dir, 'release-please-config.json'), 'utf8'), before);
        assert.deepEqual(read().packages['packages/waiting'], {
            component: 'waiting',
            'release-as': '0.0.1'
        });
    });

    it('leaves the rest of the config as it was', () => {
        const { dir, read } = repo({ plug: '0.0.1' });
        const config = read();
        config['bump-patch-for-minor-pre-major'] = true;
        fs.writeFileSync(path.join(dir, 'release-please-config.json'), `${JSON.stringify(config, null, 4)}\n`);
        assert.ok(run(dir).ok);
        assert.equal(read()['bump-patch-for-minor-pre-major'], true);
        assert.equal(read()['release-type'], 'node');
        assert.deepEqual(Object.keys(read().packages), ['packages/plug']);
    });

    it('skips a config entry that names no package', () => {
        const { dir, read } = repo({ plug: '0.0.1' });
        const config = read();
        config.packages['packages/gone'] = { component: 'gone', 'release-as': '0.0.1' };
        fs.writeFileSync(path.join(dir, 'release-please-config.json'), `${JSON.stringify(config, null, 4)}\n`);
        assert.ok(run(dir).ok);
        assert.deepEqual(read().packages['packages/gone'], { component: 'gone', 'release-as': '0.0.1' });
    });
});
