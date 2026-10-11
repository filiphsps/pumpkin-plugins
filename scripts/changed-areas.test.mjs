// Tests the change classification against throwaway git repos. Run with `pnpm test:scripts`.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const scripts = import.meta.dirname;
const dirs = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const git = (dir, ...args) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
        cwd: dir,
        encoding: 'utf8'
    });

/** Writes files (path to text, or null to delete it) and commits them. */
function commit(dir, files, message = 'change') {
    for (const [file, content] of Object.entries(files)) {
        const target = path.join(dir, file);
        if (content === null) {
            fs.rmSync(target);
            continue;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '--no-gpg-sign', '-m', message);
}

/** Commits a change and returns the sha to diff it against. */
function change(dir, files) {
    const base = git(dir, 'rev-parse', 'HEAD').trim();
    commit(dir, files);
    return base;
}

/** A throwaway repo holding one commit of the given files. */
function repo(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'changed-areas-'));
    dirs.push(dir);
    git(dir, 'init', '-q');
    commit(dir, files);
    return dir;
}

/** Runs the script in `dir` and returns whether it passed, what it logged and the outputs it wrote. */
function run(dir, ...args) {
    const outputs = path.join(dir, 'github-output');
    const result = spawnSync('node', [path.join(scripts, 'changed-areas.mjs'), ...args], {
        cwd: dir,
        env: { ...process.env, GITHUB_OUTPUT: outputs },
        encoding: 'utf8'
    });
    return {
        ok: result.status === 0,
        log: `${result.stdout}${result.stderr}`,
        outputs: fs.existsSync(outputs) ? fs.readFileSync(outputs, 'utf8') : ''
    };
}

describe('changed-areas', () => {
    it('skips the code jobs for a change that is only documentation', () => {
        const dir = repo({ 'docs/guide.md': '# Guide\n', 'packages/plug/README.md': '# Plug\n' });
        const base = change(dir, { 'docs/guide.md': '# Guide\n\nMore.\n' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=false\nactions=[]\nactions_to_test=[]\ngenerated_readmes=false\nintegration_scope=all\nintegration_extra=\n'
        );
        assert.match(result.log, /No plugin or repository code/);
    });

    it('counts anything under docs/ and the LICENSE as documentation', () => {
        const dir = repo({ 'docs/guide.md': '# Guide\n', LICENSE: 'MIT\n' });
        const base = change(dir, { 'docs/diagram.png': 'not really a png\n', LICENSE: 'MIT\n\nmore\n' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=false\nactions=[]\nactions_to_test=[]\ngenerated_readmes=false\nintegration_scope=all\nintegration_extra=\n'
        );
    });

    it('classifies nested component docs assets as documentation', () => {
        const dir = repo({ 'packages/plug/src/index.ts': 'export {};' });
        const base = change(dir, { 'packages/plug/docs/diagram.png': 'diagram' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=false\nactions=[]\nactions_to_test=[]\ngenerated_readmes=false\nintegration_scope=all\nintegration_extra=\n'
        );
    });

    it('does not schedule action tests for action-local docs assets', () => {
        const dir = repo({ 'actions/one/src/index.mjs': 'export {};' });
        const base = change(dir, { 'actions/one/docs/diagram.png': 'diagram' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=false\nactions=[]\nactions_to_test=[]\ngenerated_readmes=false\nintegration_scope=all\nintegration_extra=\n'
        );
    });

    it('runs the code jobs for a change to a source file', () => {
        const dir = repo({ 'packages/plug/src/index.ts': 'export {};\n' });
        const base = change(dir, { 'packages/plug/src/index.ts': 'export const a = 1;\n' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=true\nactions=[]\nactions_to_test=[]\ngenerated_readmes=false\nintegration_scope=affected\nintegration_extra=\n'
        );
        assert.match(result.log, /Code: packages\/plug\/src\/index\.ts/);
    });

    it('runs all integration suites for changes outside plugin runtime packages', () => {
        const dir = repo({ 'scripts/check.mjs': 'export {};\n' });
        const base = change(dir, { 'scripts/check.mjs': 'export const changed = true;\n' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=true\nactions=[]\nactions_to_test=[]\ngenerated_readmes=false\nintegration_scope=all\nintegration_extra=\n'
        );
    });

    it('includes bedrock-addon-manager when UPnPumpkin changes', () => {
        const dir = repo({ 'packages/upnpumpkin/src/plugin.ts': 'export {};\n' });
        const base = change(dir, { 'packages/upnpumpkin/src/plugin.ts': 'export const changed = true;\n' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=true\nactions=[]\nactions_to_test=[]\ngenerated_readmes=false\nintegration_scope=affected\nintegration_extra=@pumpkin-plugins/bedrock-addon-manager\n'
        );
    });

    it('runs the code jobs when one file among documentation changes', () => {
        const dir = repo({ 'docs/guide.md': '# Guide\n', '.github/workflows/ci.yml': 'name: CI\n' });
        const base = change(dir, {
            'docs/guide.md': '# Guide\n\nMore.\n',
            '.github/workflows/ci.yml': 'name: CI\n\non: push\n'
        });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=true\nactions=[]\nactions_to_test=[]\ngenerated_readmes=false\nintegration_scope=all\nintegration_extra=\n'
        );
        assert.match(result.log, /Code: \.github\/workflows\/ci\.yml/);
    });

    it('counts a deleted source file as a change to code', () => {
        const dir = repo({ 'packages/plug/src/index.ts': 'export {};\n', 'docs/guide.md': '# G\n' });
        const base = change(dir, { 'packages/plug/src/index.ts': null, 'docs/guide.md': null });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=true\nactions=[]\nactions_to_test=[]\ngenerated_readmes=false\nintegration_scope=affected\nintegration_extra=\n'
        );
    });

    it('fails on a base it cannot resolve instead of reporting no changes', () => {
        const dir = repo({ 'docs/guide.md': '# Guide\n' });
        const result = run(dir, 'nope-not-a-revision');
        assert.equal(result.ok, false);
        assert.match(result.log, /Could not diff nope-not-a-revision/);
        assert.equal(result.outputs, '');
    });

    it('says how to use it when given no base', () => {
        const result = run(repo({ 'docs/guide.md': '# Guide\n' }));
        assert.equal(result.ok, false);
        assert.match(result.log, /Usage: changed-areas\.mjs <base> \[head\]/);
    });

    it('defaults the head to HEAD, so it works on the commit being pushed', () => {
        const dir = repo({ 'packages/plug/src/index.ts': 'export {};\n' });
        const base = change(dir, { 'packages/plug/src/index.ts': 'export const a = 1;\n' });
        const result = run(dir, base);
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=true\nactions=[]\nactions_to_test=[]\ngenerated_readmes=false\nintegration_scope=affected\nintegration_extra=\n'
        );
    });

    it('skips plugin code jobs and reports only the changed action', () => {
        const dir = repo({ 'actions/one/action.yml': 'name: One\n', 'actions/two/action.yml': 'name: Two\n' });
        const base = change(dir, { 'actions/two/action.yml': 'name: Two\ndescription: Updated\n' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=false\nactions=["two"]\nactions_to_test=["two"]\ngenerated_readmes=false\nintegration_scope=all\nintegration_extra=\n'
        );
        assert.match(result.log, /Actions to test: two/);
    });

    it('reports changed actions separately when they change with plugin code', () => {
        const dir = repo({
            'actions/one/action.yml': 'name: One\n',
            'actions/two/action.yml': 'name: Two\n',
            'packages/plug/src/index.ts': 'export {};\n'
        });
        const base = change(dir, {
            'actions/two/action.yml': 'name: Two\ndescription: Updated\n',
            'packages/plug/src/index.ts': 'export const changed = true;\n'
        });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=true\nactions=["two"]\nactions_to_test=["two"]\ngenerated_readmes=false\nintegration_scope=affected\nintegration_extra=\n'
        );
    });

    it('does not test an action when only its Release Please version file changes', () => {
        const dir = repo({ 'actions/one/action.yml': 'name: One\n', 'actions/one/version.txt': '0.0.0\n' });
        const base = change(dir, { 'actions/one/version.txt': '0.0.1\n' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=false\nactions=["one"]\nactions_to_test=[]\ngenerated_readmes=false\nintegration_scope=all\nintegration_extra=\n'
        );
    });

    for (const deleted of [false, true]) {
        it(`tests common and all public consumers when a helper is ${deleted ? 'deleted' : 'changed'}`, () => {
            const dir = repo({ 'actions/common/src/input.mjs': 'export {};\n' });
            const base = change(dir, {
                'actions/common/src/input.mjs': deleted ? null : 'export const changed = true;\n'
            });
            const result = run(dir, base, 'HEAD');
            assert.ok(result.ok, result.log);
            assert.equal(
                result.outputs,
                'code=false\nactions=[]\nactions_to_test=["common","publish-to-pumpkin-market","sign-pumpkin-plugin","update-pumpkin-market-listing","verify-pumpkin-plugin"]\ngenerated_readmes=false\nintegration_scope=all\nintegration_extra=\n'
            );
        });
    }

    it('keeps common docs and version-only changes out of consumer tests and releases', () => {
        const dir = repo({ 'actions/common/README.md': '# Common\n', 'actions/common/version.txt': '1\n' });
        const base = change(dir, {
            'actions/common/README.md': '# Common\nMore\n',
            'actions/common/version.txt': '2\n'
        });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=false\nactions=[]\nactions_to_test=[]\ngenerated_readmes=false\nintegration_scope=all\nintegration_extra=\n'
        );
    });

    it('expands common consumers alongside mixed plugin and public action changes', () => {
        const dir = repo({ 'actions/common/src/input.mjs': 'export {};\n' });
        const base = change(dir, {
            'actions/common/src/input.mjs': 'export const changed = true;\n',
            'actions/sign-pumpkin-plugin/src/index.mjs': 'export {};\n',
            'packages/plug/src/plugin.ts': 'export {};\n'
        });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=true\nactions=["sign-pumpkin-plugin"]\nactions_to_test=["common","publish-to-pumpkin-market","sign-pumpkin-plugin","update-pumpkin-market-listing","verify-pumpkin-plugin"]\ngenerated_readmes=false\nintegration_scope=affected\nintegration_extra=\n'
        );
    });

    it('detects the generated README commit that should rerun CI documentation checks', () => {
        const dir = repo({ 'packages/plug/README.md': '# Plug\n' });
        const base = git(dir, 'rev-parse', 'HEAD').trim();
        commit(dir, { 'packages/plug/README.md': '# Plug\n\nGenerated docs.\n' }, 'docs: update generated READMEs');
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=false\nactions=[]\nactions_to_test=[]\ngenerated_readmes=true\nintegration_scope=all\nintegration_extra=\n'
        );
        assert.match(result.log, /Generated README update commit detected/);
    });
});
