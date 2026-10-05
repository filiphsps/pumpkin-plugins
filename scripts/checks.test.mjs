// Tests for the repo checks (check-docs, check-release-config, package-metadata) against small
// throwaway repos. Run with `pnpm test:scripts`.

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

/** Writes files (path to text, or an object for JSON) into a new temporary repo and returns its path. */
function repo(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-'));
    dirs.push(dir);
    for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(
            path.join(dir, file),
            typeof content === 'string' ? content : `${JSON.stringify(content, null, 4)}\n`
        );
    }
    return dir;
}

function run(script, dir, ...args) {
    const result = spawnSync('node', [path.join(scripts, script), ...args], {
        env: { ...process.env, PUMPKIN_PLUGINS_ROOT: dir },
        encoding: 'utf8'
    });
    return { ok: result.status === 0, out: `${result.stdout}${result.stderr}` };
}

const AUTHOR = 'Filiph Sandström <filfat@hotmail.se> (https://github.com/filiphsps)';
const REPO = 'https://github.com/filiphsps/pumpkin-plugins';
const metadata = (dir) => ({
    license: 'MIT',
    author: AUTHOR,
    contributors: [AUTHOR],
    homepage: dir === '.' ? REPO : `${REPO}/tree/master/${dir}#readme`,
    repository: { type: 'git', url: `git+${REPO}.git`, ...(dir === '.' ? {} : { directory: dir }) },
    bugs: { url: `${REPO}/issues` },
    funding: [
        { type: 'github', url: 'https://github.com/sponsors/filiphsps' },
        { type: 'custom', url: 'https://paypal.me/filiph' }
    ]
});

describe('check-docs', () => {
    const good = {
        'package.json': { name: 'root', scripts: { test: 'x' } },
        'README.md':
            '# Root\n\nRun `pnpm test`. See [docs](docs/README.md) and [the guide](docs/guide.md#getting-started).\n',
        'docs/README.md': '# Docs\n\n| [Guide](guide.md) | the guide |\n',
        'docs/guide.md': '# Guide\n\n## Getting started\n\nSee `tools/kit/src/a.ts`.\n',
        'tools/kit/package.json': { name: '@x/kit', scripts: {} },
        'tools/kit/README.md': '# @x/kit\n\nA kit.\n',
        'tools/kit/src/a.ts': ''
    };

    it('passes for a repo whose docs match', () => {
        const result = run('check-docs.mjs', repo(good));
        assert.ok(result.ok, result.out);
    });

    it('fails for a package without a README, and for one that does not name itself', () => {
        const { 'tools/kit/README.md': _, ...without } = good;
        assert.match(run('check-docs.mjs', repo(without)).out, /tools\/kit\/README\.md is missing/);
        const result = run('check-docs.mjs', repo({ ...good, 'tools/kit/README.md': '# Something\n' }));
        assert.match(result.out, /should mention @x\/kit/);
    });

    it('fails for links to files or headings that do not exist, but not for links in code', () => {
        const broken = run(
            'check-docs.mjs',
            repo({ ...good, 'docs/guide.md': '# Guide\n\n[x](missing.md) [y](README.md#nope)\n' })
        );
        assert.match(broken.out, /links to missing\.md, which does not exist/);
        assert.match(broken.out, /links to README\.md#nope, but docs\/README\.md has no such heading/);
        const inCode = run(
            'check-docs.mjs',
            repo({ ...good, 'docs/guide.md': '# Guide\n\n## Getting started\n\n`[x](missing.md)`\n' })
        );
        assert.ok(inCode.ok, inCode.out);
    });

    it('fails for a path in a code span that does not exist', () => {
        const result = run(
            'check-docs.mjs',
            repo({ ...good, 'docs/guide.md': '# Guide\n\n`tools/kit/src/gone.ts`\n' })
        );
        assert.match(result.out, /mentions tools\/kit\/src\/gone\.ts, which does not exist/);
    });

    it('fails for a pnpm command that is not a script, but allows pnpm built-ins', () => {
        const bad = run('check-docs.mjs', repo({ ...good, 'docs/guide.md': '# Guide\n\n```sh\npnpm nonsense\n```\n' }));
        assert.match(bad.out, /runs `pnpm nonsense`/);
        const builtin = run(
            'check-docs.mjs',
            repo({
                ...good,
                'docs/guide.md': '# Guide\n\n## Getting started\n\n```sh\npnpm install\npnpm exec foo\n```\n'
            })
        );
        assert.ok(builtin.ok, builtin.out);
    });

    it('fails for a root script that no doc mentions', () => {
        const result = run(
            'check-docs.mjs',
            repo({ ...good, 'package.json': { name: 'root', scripts: { test: 'x', deploy: 'y' } } })
        );
        assert.match(result.out, /the script "deploy"/);
    });

    it('fails for a doc page the index does not list', () => {
        const result = run('check-docs.mjs', repo({ ...good, 'docs/extra.md': '# Extra\n' }));
        assert.match(result.out, /docs\/README\.md does not list docs\/extra\.md/);
    });

    it('fails for a CI job the CI doc does not list', () => {
        const ci = {
            '.github/workflows/ci.yml': [
                'jobs:',
                '    lint:',
                '        name: 📋 Lint',
                '    ship:',
                '        name: 🚀 Ship ' + '$' + '{{ x }}',
                ''
            ].join('\n')
        };
        const docs = { 'docs/ci-and-releases.md': '# CI\n\n| 📋 Lint | always |\n' };
        const result = run(
            'check-docs.mjs',
            repo({
                ...good,
                ...ci,
                ...docs,
                'docs/README.md': '# Docs\n\n[Guide](guide.md) [CI](ci-and-releases.md)\n'
            })
        );
        assert.match(result.out, /does not list the CI job "🚀 Ship"/);
        assert.doesNotMatch(result.out, /Lint/);
    });

    it('ignores scratch folders that start with an underscore', () => {
        const result = run('check-docs.mjs', repo({ ...good, 'tools/_scratch/package.json': { name: 'scratch' } }));
        assert.ok(result.ok, result.out);
    });
});

describe('package-metadata', () => {
    const files = (override = {}) => ({
        LICENSE: 'MIT',
        'package.json': { name: 'root', description: 'Root', ...metadata('.') },
        'packages/plug/package.json': {
            name: 'plug',
            version: '0.0.0',
            description: 'A plugin',
            ...metadata('packages/plug')
        },
        'tools/lib/package.json': {
            name: 'lib',
            description: 'A library',
            ...metadata('tools/lib'),
            sideEffects: false,
            module: './src/index.ts',
            types: './src/index.ts',
            exports: { '.': './src/index.ts' },
            files: ['src'],
            publishConfig: { access: 'public' }
        },
        ...override
    });

    it('passes when everything is there', () => {
        const result = run('package-metadata.mjs', repo(files()));
        assert.ok(result.ok, result.out);
    });

    it('names the missing or wrong fields', () => {
        const plug = {
            name: 'plug',
            version: '0.0.0',
            description: 'A plugin',
            ...metadata('packages/plug'),
            license: 'ISC'
        };
        plug.bugs = undefined;
        const result = run('package-metadata.mjs', repo(files({ 'packages/plug/package.json': plug })));
        assert.match(result.out, /packages\/plug\/package\.json: "license" should be "MIT"/);
        assert.match(result.out, /"bugs" should be/);
    });

    it('wants a short description', () => {
        const long = { name: 'plug', version: '0.0.0', description: 'x'.repeat(71), ...metadata('packages/plug') };
        assert.match(
            run('package-metadata.mjs', repo(files({ 'packages/plug/package.json': long }))).out,
            /"description" is 71 characters/
        );
        const none = { name: 'plug', version: '0.0.0', ...metadata('packages/plug') };
        assert.match(
            run('package-metadata.mjs', repo(files({ 'packages/plug/package.json': none }))).out,
            /"description" is missing/
        );
    });

    it('wants the library fields on a tool that exports code', () => {
        const lib = {
            name: 'lib',
            description: 'A library',
            ...metadata('tools/lib'),
            exports: { '.': './src/index.ts' }
        };
        const result = run('package-metadata.mjs', repo(files({ 'tools/lib/package.json': lib })));
        assert.match(result.out, /"sideEffects" should be false/);
        assert.match(result.out, /"module" should be "\.\/src\/index\.ts"/);
        assert.match(result.out, /"publishConfig" should be/);
    });

    it('--fix writes what can be derived and still fails on a missing description', () => {
        const dir = repo(files({ 'tools/lib/package.json': { name: 'lib', exports: { '.': './src/index.ts' } } }));
        const result = run('package-metadata.mjs', dir, '--fix');
        assert.equal(result.ok, false);
        assert.match(result.out, /"description" is missing/);
        const fixed = JSON.parse(fs.readFileSync(path.join(dir, 'tools/lib/package.json'), 'utf8'));
        assert.equal(fixed.license, 'MIT');
        assert.equal(fixed.sideEffects, false);
        assert.deepEqual(Object.keys(fixed).slice(0, 3), ['name', 'license', 'author']);
    });

    it('fails without a LICENSE file', () => {
        const { LICENSE: _, ...withoutLicense } = files();
        assert.match(run('package-metadata.mjs', repo(withoutLicense)).out, /LICENSE is missing/);
    });
});

describe('check-release-config', () => {
    const files = ({ manifest = '0.0.0', releaseAs = '0.0.1', version = '0.0.0' } = {}) => ({
        'packages/plug/package.json': { name: 'plug', version },
        '.release-please-manifest.json': { 'packages/plug': manifest },
        'release-please-config.json': {
            'separate-pull-requests': true,
            'always-update': false,
            'force-tag-creation': true,
            packages: { 'packages/plug': { component: 'plug', ...(releaseAs ? { 'release-as': releaseAs } : {}) } }
        }
    });

    it('passes for an unreleased plugin that is set to release 0.0.1', () => {
        const result = run('check-release-config.mjs', repo(files()));
        assert.ok(result.ok, result.out);
    });

    it('requires release-as 0.0.1 until the first release', () => {
        const result = run('check-release-config.mjs', repo(files({ releaseAs: null })));
        assert.match(result.out, /needs "release-as": "0\.0\.1"/);
        assert.match(
            run('check-release-config.mjs', repo(files({ releaseAs: '0.1.0' }))).out,
            /needs "release-as": "0\.0\.1"/
        );
    });

    it('wants release-as gone once the plugin is released', () => {
        const released = run('check-release-config.mjs', repo(files({ manifest: '0.0.1', version: '0.0.1' })));
        assert.match(released.out, /remove "release-as"/);
        assert.ok(
            run('check-release-config.mjs', repo(files({ manifest: '0.0.1', version: '0.0.1', releaseAs: null }))).ok
        );
    });

    it('still checks registration and matching versions', () => {
        const unregistered = {
            'packages/plug/package.json': { name: 'plug', version: '0.0.0' },
            '.release-please-manifest.json': {},
            'release-please-config.json': { packages: {} }
        };
        assert.match(run('check-release-config.mjs', repo(unregistered)).out, /not in release-please-config\.json/);
        assert.match(
            run('check-release-config.mjs', repo(files({ manifest: '0.0.0', version: '0.0.5' }))).out,
            /must match/
        );
    });

    it('requires independent release PRs but permits always-update to stay disabled', () => {
        const combined = files();
        combined['release-please-config.json']['separate-pull-requests'] = false;
        assert.match(run('check-release-config.mjs', repo(combined)).out, /"separate-pull-requests": true/);

        const withAlwaysUpdate = files();
        withAlwaysUpdate['release-please-config.json']['always-update'] = true;
        assert.match(run('check-release-config.mjs', repo(withAlwaysUpdate)).out, /"always-update": false/);

        const withoutTag = files();
        withoutTag['release-please-config.json']['force-tag-creation'] = false;
        assert.match(run('check-release-config.mjs', repo(withoutTag)).out, /"force-tag-creation": true/);
    });
});
