import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dirname, '..');
const helper = path.join(root, 'scripts', 'market-plugin-name.mjs');
const releaseWorkflow = parse(fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8'));
const dirs = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('market-plugin-name', () => {
    it('prints the canonical name exported by the package info module', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-plugin-name-'));
        dirs.push(dir);
        fs.mkdirSync(path.join(dir, 'src'));
        fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
        fs.writeFileSync(path.join(dir, 'src', 'info.ts'), "export const info = { name: 'Published plugin' };");

        const result = spawnSync('node', [helper, dir], { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), 'Published plugin');
    });

    it('validates the tagged plugin identity before writing asset job outputs', () => {
        const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'market-plugin-name-'));
        dirs.push(sourceRoot);
        fs.mkdirSync(path.join(sourceRoot, 'packages/plugin/src'), { recursive: true });
        fs.writeFileSync(
            path.join(sourceRoot, 'release-please-config.json'),
            JSON.stringify({ packages: { 'packages/plugin': { component: 'plugin' } } }),
        );
        fs.writeFileSync(path.join(sourceRoot, '.release-please-manifest.json'), '{"packages/plugin":"1.2.3"}');
        fs.writeFileSync(
            path.join(sourceRoot, 'packages/plugin/package.json'),
            JSON.stringify({
                version: '1.2.3',
                pumpkinPlugin: { info: 'src/info.mjs', output: 'build/plugin.wasm' },
            }),
        );
        fs.writeFileSync(
            path.join(sourceRoot, 'packages/plugin/src/info.mjs'),
            `export const info = { name: ${JSON.stringify('Published plugin\nplugin_name=Attacker')} };`,
        );

        const step = releaseWorkflow.jobs.assets.steps.find(({ id }) => id === 'plugin');
        assert.ok(step?.run, 'missing asset input resolver run block');

        const outputFile = path.join(sourceRoot, 'github-output');
        fs.writeFileSync(outputFile, '');
        const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], {
            cwd: root,
            encoding: 'utf8',
            env: { ...process.env, GITHUB_OUTPUT: outputFile, SOURCE_ROOT: sourceRoot, TAG: 'plugin-v1.2.3' },
        });

        assert.notEqual(result.status, 0, result.stderr);
        assert.match(result.stderr, /single-line name/);
        assert.equal(fs.readFileSync(outputFile, 'utf8'), '');
    });

    it('uses the release artifact metadata for Market inputs', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-plugin-name-'));
        dirs.push(dir);
        fs.mkdirSync(path.join(dir, 'dist'));
        fs.writeFileSync(
            path.join(dir, 'dist', 'release-metadata.json'),
            JSON.stringify({ plugin_name: 'UPnPumpkin', version: '1.2.3', wasm_file: 'dist/plugin.wasm' }),
        );

        const step = releaseWorkflow.jobs.market.steps.find(({ id }) => id === 'market');
        assert.ok(step?.run, 'missing Market input resolver run block');

        const outputFile = path.join(dir, 'github-output');
        const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], {
            cwd: dir,
            encoding: 'utf8',
            env: { ...process.env, GITHUB_OUTPUT: outputFile },
        });

        assert.equal(result.status, 0, result.stderr);
        assert.equal(
            fs.readFileSync(outputFile, 'utf8'),
            'plugin_name=UPnPumpkin\nversion=1.2.3\nwasm_file=dist/plugin.wasm\n',
        );
    });
});
