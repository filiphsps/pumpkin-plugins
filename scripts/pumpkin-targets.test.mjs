import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, it } from 'node:test';
import { readTarget, resolveBuildTarget, targetEnvironment } from './pumpkin-targets.mjs';

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
it('resolves API code and WIT from independent local checkouts', async () => {
    const { root, api, wit, env } = fixture();
    const result = await resolveBuildTarget(root, { root, env });
    assert.equal(result.apiEntry, path.join(api, 'dist/index.ts'));
    assert.equal(result.witRoot, wit);
    fs.rmSync(path.join(wit, 'plugin.wit'));
    await assert.rejects(resolveBuildTarget(root, { root, env }), /plugin.wit/);
});
it('changes task identity when local API source changes at the same path', async () => {
    const { root, api, env } = fixture();
    const before = await targetEnvironment(root, env);
    fs.writeFileSync(path.join(api, 'dist/index.ts'), 'export const value = 99;');
    const after = await targetEnvironment(root, env);
    assert.notEqual(before.PUMPKIN_API_REVISION, after.PUMPKIN_API_REVISION);
    assert.equal(before.PUMPKIN_WIT_REVISION, after.PUMPKIN_WIT_REVISION);
    assert.equal(after.PUMPKIN_API_TARGET, 'future');
});
it('materializes missing API declarations from selected WIT without editing a local checkout', async () => {
    const { root, api, env } = fixture();
    fs.writeFileSync(
        path.join(api, 'dist/index.ts'),
        '/// <reference path="./bindings/index.d.ts" />\nexport const value = 42;'
    );
    const inputs = await resolveBuildTarget(root, { root, env });
    assert.ok(fs.existsSync(path.join(path.dirname(inputs.apiEntry), 'bindings/index.d.ts')));
    assert.equal(fs.existsSync(path.join(api, 'dist/bindings')), false);
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
it('hashes linked local source contents as well as the link target', async () => {
    const { root, api, env } = fixture();
    const source = path.join(root, 'linked-source.ts');
    fs.writeFileSync(source, 'export const value = 1;');
    fs.rmSync(path.join(api, 'dist/index.ts'));
    fs.symlinkSync(source, path.join(api, 'dist/index.ts'));
    const before = await targetEnvironment(root, env);
    fs.writeFileSync(source, 'export const value = 2;');
    const after = await targetEnvironment(root, env);
    assert.notEqual(before.PUMPKIN_API_REVISION, after.PUMPKIN_API_REVISION);
});
it('keeps installed release WIT when only the API runtime checkout is overridden', async () => {
    const { root, api, env } = fixture();
    const file = path.join(root, 'pumpkin-api-targets.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.targets.future.wit.installedPath = 'wit/v0.1';
    fs.writeFileSync(file, JSON.stringify(config));
    const installed = path.join(root, 'tools/plugin-kit/node_modules/@pumpkinmc/pumpkin-api-ts');
    fs.mkdirSync(path.join(installed, 'wit/v0.1'), { recursive: true });
    fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: '@pumpkinmc/pumpkin-api-ts' }));
    fs.writeFileSync(path.join(installed, 'wit/v0.1/plugin.wit'), 'world plugin {}');
    const inputs = await resolveBuildTarget(root, { root, env: { ...env, PUMPKIN_WIT_DIR: undefined } });
    assert.equal(inputs.apiRoot, api);
    assert.equal(fs.realpathSync(inputs.witRoot), fs.realpathSync(path.join(installed, 'wit/v0.1')));
});

it('preserves a configured API entry through the root runner environment', async () => {
    const { root, api, env } = fixture();
    const selected = path.join(api, 'dist/alternate.ts');
    fs.writeFileSync(selected, 'export const value = 99;');
    const file = path.join(root, 'pumpkin-api-targets.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.targets.future.api.entry = 'dist/alternate.ts';
    config.targets.future.api.installedVersion = '0.1.1';
    fs.writeFileSync(file, JSON.stringify(config));
    fs.writeFileSync(path.join(api, 'package.json'), JSON.stringify({ main: 'dist/index.ts', version: '0.1.1' }));
    const installed = path.join(root, 'tools/plugin-kit/node_modules/@pumpkinmc');
    fs.mkdirSync(installed, { recursive: true });
    fs.symlinkSync(api, path.join(installed, 'pumpkin-api-ts'));
    const runnerEnv = await targetEnvironment(root, { ...env, PUMPKIN_API_DIR: undefined });
    const inputs = await resolveBuildTarget(root, { root, env: runnerEnv });
    assert.equal(fs.realpathSync(inputs.apiEntry), fs.realpathSync(selected));
});
