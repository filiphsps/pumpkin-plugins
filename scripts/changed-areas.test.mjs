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
function commit(dir, files) {
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
    git(dir, 'commit', '-q', '--no-gpg-sign', '-m', 'change');
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
        assert.equal(result.outputs, 'code=false\n');
        assert.match(result.log, /Nothing but docs/);
    });

    it('counts anything under docs/ and the LICENSE as documentation', () => {
        const dir = repo({ 'docs/guide.md': '# Guide\n', LICENSE: 'MIT\n' });
        const base = change(dir, { 'docs/diagram.png': 'not really a png\n', LICENSE: 'MIT\n\nmore\n' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(result.outputs, 'code=false\n');
    });

    it('runs the code jobs for a change to a source file', () => {
        const dir = repo({ 'packages/plug/src/index.ts': 'export {};\n' });
        const base = change(dir, { 'packages/plug/src/index.ts': 'export const a = 1;\n' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(result.outputs, 'code=true\n');
        assert.match(result.log, /Code: packages\/plug\/src\/index\.ts/);
    });

    it('runs the code jobs when one file among documentation changes', () => {
        const dir = repo({ 'docs/guide.md': '# Guide\n', '.github/workflows/ci.yml': 'name: CI\n' });
        const base = change(dir, {
            'docs/guide.md': '# Guide\n\nMore.\n',
            '.github/workflows/ci.yml': 'name: CI\n\non: push\n'
        });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(result.outputs, 'code=true\n');
        assert.match(result.log, /Code: \.github\/workflows\/ci\.yml/);
    });

    it('counts a deleted source file as a change to code', () => {
        const dir = repo({ 'packages/plug/src/index.ts': 'export {};\n', 'docs/guide.md': '# G\n' });
        const base = change(dir, { 'packages/plug/src/index.ts': null, 'docs/guide.md': null });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(result.outputs, 'code=true\n');
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
        assert.equal(result.outputs, 'code=true\n');
    });
});
