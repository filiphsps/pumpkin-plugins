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

    for (const { job, stepId } of [
        { job: 'assets', stepId: 'plugin' },
        { job: 'market', stepId: 'market' },
    ]) {
        it(`rejects line breaks before the ${job} job writes GitHub outputs`, () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-plugin-name-'));
            dirs.push(dir);
            fs.mkdirSync(path.join(dir, 'src'));
            fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
            fs.writeFileSync(
                path.join(dir, 'src', 'info.ts'),
                `export const info = { name: ${JSON.stringify('Published plugin\nplugin_name=Attacker')} };`,
            );

            const step = releaseWorkflow.jobs[job].steps.find(({ id }) => id === stepId);
            assert.ok(step?.run, `missing run block for ${job} job`);

            const outputFile = path.join(dir, 'github-output');
            fs.writeFileSync(outputFile, '');
            const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], {
                cwd: root,
                encoding: 'utf8',
                env: {
                    ...process.env,
                    GITHUB_OUTPUT: outputFile,
                    PLUGIN_DIRECTORY: dir,
                    RELEASE_TAG: 'plugin-v1.2.3',
                },
            });

            assert.notEqual(result.status, 0, result.stderr);
            assert.match(result.stderr, /nonempty single-line name/);
            assert.equal(fs.readFileSync(outputFile, 'utf8'), '');
        });
    }
});
