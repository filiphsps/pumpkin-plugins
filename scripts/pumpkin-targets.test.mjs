import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, it } from 'node:test';
import { readTarget } from './pumpkin-targets.mjs';

const dirs = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-target-'));
    dirs.push(root);
    const api = path.join(root, 'api');
    const wit = path.join(root, 'wit');
    fs.mkdirSync(path.join(api, 'dist'), { recursive: true });
    fs.mkdirSync(wit);
    fs.writeFileSync(
        path.join(api, 'package.json'),
        JSON.stringify({ name: '@pumpkinmc/pumpkin-api-ts', main: 'dist/index.ts' })
    );
    fs.writeFileSync(path.join(api, 'dist/index.ts'), 'export const value = 42;');
    fs.writeFileSync(path.join(wit, 'plugin.wit'), 'package pumpkin:plugin@0.1.0; world plugin {}');
    const profile = {
        api: { repository: 'Pumpkin-MC/pumpkin-api-ts', ref: 'a'.repeat(40), entry: 'dist/index.ts' },
        wit: { repository: 'Pumpkin-MC/Pumpkin', ref: 'b'.repeat(40), path: 'crates/pumpkin-plugin-wit/v0.1' },
        server: {
            repository: 'Pumpkin-MC/Pumpkin',
            ref: 'b'.repeat(40),
            tag: 'nightly',
            sha256: { 'pumpkin-X64-Linux': 'c'.repeat(64) }
        }
    };
    fs.writeFileSync(
        path.join(root, 'pumpkin-api-targets.json'),
        JSON.stringify({
            default: 'release',
            compatibility: ['release', 'future'],
            targets: { release: profile, future: profile }
        })
    );
    return { root, api, wit, env: { PUMPKIN_API_TARGET: 'future', PUMPKIN_API_DIR: api, PUMPKIN_WIT_DIR: wit } };
}
it('accepts another release profile without a code enum and rejects unknown targets', () => {
    const { root } = fixture();
    assert.equal(readTarget(root, 'future').name, 'future');
    assert.throws(() => readTarget(root, 'typo'), /Unknown Pumpkin API target/);
});
it('rejects mutable source refs and unpinned nightly binaries before resolving inputs', () => {
    const { root } = fixture();
    const file = path.join(root, 'pumpkin-api-targets.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.targets.future.api.ref = 'master';
    fs.writeFileSync(file, JSON.stringify(config));
    assert.throws(() => readTarget(root, 'future'), /40-character/);
    config.targets.future.api.ref = 'a'.repeat(40);
    config.targets.future.server.sha256 = {};
    fs.writeFileSync(file, JSON.stringify(config));
    assert.throws(() => readTarget(root, 'future'), /digest/);
});
it('rejects profile typos and paths escaping the source tree', () => {
    const { root } = fixture();
    const file = path.join(root, 'pumpkin-api-targets.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.targets.future.api.revision = 'a'.repeat(40);
    fs.writeFileSync(file, JSON.stringify(config));
    assert.throws(() => readTarget(root, 'future'), /Unknown.*revision/);
    config.targets.future.api.revision = undefined;
    config.targets.future.wit.path = '../outside';
    fs.writeFileSync(file, JSON.stringify(config));
    assert.throws(() => readTarget(root, 'future'), /relative path/);
});
