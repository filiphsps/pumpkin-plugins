// Tests for the repo checks (check-docs, check-release-config, package-metadata) against small
// throwaway repos. Workflow tests live in workflows.test.mjs. Run with `pnpm test:scripts`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { generateDocsIndex } from '@pumpkin-plugins/docs/node';

const scripts = import.meta.dirname;
const scopedReleaseTitlePattern = ['chore$', '{scope}: release @pumpkin-plugins/$', '{component} $', '{version}'].join(
    '',
);
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
            typeof content === 'string' ? content : `${JSON.stringify(content, null, 4)}\n`,
        );
    }
    return dir;
}

function repoWithCurrentDocsIndex(files) {
    const dir = repo(files);
    generateDocsIndex(dir);
    return dir;
}

function run(script, dir, ...args) {
    const result = spawnSync('node', [path.join(scripts, script), ...args], {
        env: { ...process.env, PUMPKIN_PLUGINS_ROOT: dir },
        encoding: 'utf8',
    });
    return { ok: result.status === 0, out: `${result.stdout}${result.stderr}` };
}

const REPO = 'https://github.com/filiphsps/pumpkin-plugins';
const metadata = (dir) => ({
    homepage: dir === '.' ? REPO : `${REPO}/tree/master/${dir}#readme`,
    bugs: { url: `${REPO}/issues` },
    repository: { type: 'git', url: `git+${REPO}.git`, ...(dir === '.' ? {} : { directory: dir }) },
    license: 'MIT',
});

describe('check-docs', () => {
    const good = {
        'package.json': { name: 'root', scripts: { test: 'x', readme: 'x' } },
        'README.md':
            '# Root\n\nRun `pnpm test`. See [docs](docs/README.md) and [the guide](docs/guide.md#getting-started).\n',
        'docs/README.md': '# Docs\n\n<!-- docs:begin site-index -->\n<!-- docs:end site-index -->\n',
        'docs/guide.md': '# Guide\n\n## Getting started\n\nSee `tools/kit/src/a.ts`.\n',
        'tools/kit/package.json': { name: '@x/kit', scripts: {} },
        'tools/kit/README.md': '# @x/kit\n\nA kit.\n',
        'tools/kit/src/a.ts': '',
    };

    it('passes for a repo whose docs match', () => {
        const result = run('check-docs.mjs', repoWithCurrentDocsIndex(good));
        assert.ok(result.ok, result.out);
    });

    it('fails for a package without a README, and for one that does not name itself', () => {
        const { 'tools/kit/README.md': _, ...without } = good;
        assert.match(run('check-docs.mjs', repoWithCurrentDocsIndex(without)).out, /tools\/kit\/README\.md is missing/);
        const result = run(
            'check-docs.mjs',
            repoWithCurrentDocsIndex({ ...good, 'tools/kit/README.md': '# Something\n' }),
        );
        assert.match(result.out, /should mention @x\/kit/);
    });

    it('fails for links to files or headings that do not exist, but not for links in code', () => {
        const broken = run(
            'check-docs.mjs',
            repoWithCurrentDocsIndex({ ...good, 'docs/guide.md': '# Guide\n\n[x](missing.md) [y](README.md#nope)\n' }),
        );
        assert.match(broken.out, /links to missing\.md, which does not exist/);
        assert.match(broken.out, /links to README\.md#nope, but docs\/README\.md has no such heading/);
        const inCode = run(
            'check-docs.mjs',
            repoWithCurrentDocsIndex({
                ...good,
                'docs/guide.md': '# Guide\n\n## Getting started\n\n`[x](missing.md)`\n',
            }),
        );
        assert.ok(inCode.ok, inCode.out);
    });

    it('resolves heading links the way GitHub names them', () => {
        const headings =
            '# Guide\n\n## Getting started\n\n## Use foo_bar\n\n## Setup\n\n## Setup\n\n```sh\n# Setup\n```\n';
        const valid = run(
            'check-docs.mjs',
            repoWithCurrentDocsIndex({
                ...good,
                'docs/guide.md': `${headings}\n[a](#use-foo_bar) [b](#setup) [c](#setup-1)\n`,
            }),
        );
        assert.ok(valid.ok, valid.out);
        const broken = run(
            'check-docs.mjs',
            repoWithCurrentDocsIndex({
                ...good,
                'docs/guide.md': `${headings}\n[a](#use-foobar) [b](#setup-2)\n`,
            }),
        );
        assert.match(broken.out, /links to #use-foobar, but docs\/guide\.md has no such heading/);
        assert.match(broken.out, /links to #setup-2, but docs\/guide\.md has no such heading/);
    });

    it('checks links with titles and reference-style links', () => {
        const result = run(
            'check-docs.mjs',
            repoWithCurrentDocsIndex({
                ...good,
                'docs/guide.md': '# Guide\n\n[x](titled.md "Title") [y][ref]\n\n[ref]: referenced.md\n',
            }),
        );
        assert.match(result.out, /links to titled\.md, which does not exist/);
        assert.match(result.out, /links to referenced\.md, which does not exist/);
    });

    it('accepts links to generated API pages whether or not the ignored API output exists', () => {
        const result = run(
            'check-docs.mjs',
            repoWithCurrentDocsIndex({
                ...good,
                'docs/guide.md':
                    '# Guide\n\n## Getting started\n\nSee `tools/kit/src/a.ts` and [the API](/api/kit/).\n',
            }),
        );
        assert.ok(result.ok, result.out);

        const built = run(
            'check-docs.mjs',
            repoWithCurrentDocsIndex({
                ...good,
                'docs/guide.md':
                    '# Guide\n\n## Getting started\n\nSee `tools/kit/src/a.ts` and [the API](/api/kit/).\n',
                'docs/api/other/index.md': '# Other\n',
            }),
        );
        assert.ok(built.ok, `a local API build must not change the result:\n${built.out}`);
    });

    it('validates agent guidance and skill links and commands too', () => {
        const result = run(
            'check-docs.mjs',
            repoWithCurrentDocsIndex({
                ...good,
                'AGENTS.md': '# Agents\n\n[missing](.agents/skills/missing/SKILL.md)\n',
                '.agents/skills/example/SKILL.md':
                    '# Skill\n\nRun `pnpm nonexistent`. See `.agents/hooks/missing.mjs`.\n',
            }),
        );
        assert.equal(result.ok, false);
        assert.match(result.out, /AGENTS\.md links to/);
        assert.match(result.out, /SKILL\.md runs `pnpm nonexistent`/);
        assert.match(result.out, /mentions \.agents\/hooks\/missing\.mjs/);
    });

    it('fails for a path in a code span that does not exist', () => {
        const result = run(
            'check-docs.mjs',
            repo({ ...good, 'docs/guide.md': '# Guide\n\n`tools/kit/src/gone.ts`\n' }),
        );
        assert.match(result.out, /mentions tools\/kit\/src\/gone\.ts, which does not exist/);
    });

    it('accepts a documented plugin build output declared by its package', () => {
        const result = run(
            'check-docs.mjs',
            repoWithCurrentDocsIndex({
                ...good,
                'packages/waypoints/package.json': {
                    name: '@x/waypoints',
                    pumpkinPlugin: { output: 'build/waypoints.wasm' },
                },
                'packages/waypoints/README.md': '# @x/waypoints\n\nCopy `packages/waypoints/build/waypoints.wasm`.\n',
            }),
        );
        assert.ok(result.ok, result.out);
    });

    it('validates private benchmark Markdown and repository paths without treating it as a public component', () => {
        const result = run(
            'check-docs.mjs',
            repoWithCurrentDocsIndex({
                ...good,
                'benchmarks/engine-comparison/README.md':
                    '# Engine comparison\n\nSee [the guide](../../docs/guide.md) and `benchmarks/engine-comparison/src/workload.ts`.\n',
                'benchmarks/engine-comparison/src/workload.ts': 'export {};\n',
            }),
        );
        assert.ok(result.ok, result.out);
        const broken = run(
            'check-docs.mjs',
            repoWithCurrentDocsIndex({
                ...good,
                'benchmarks/engine-comparison/README.md':
                    '# Engine comparison\n\n`benchmarks/engine-comparison/src/missing.ts`\n',
            }),
        );
        assert.match(broken.out, /mentions benchmarks\/engine-comparison\/src\/missing\.ts, which does not exist/);
    });

    it('fails for a pnpm command that is not a script, but allows pnpm built-ins', () => {
        const bad = run('check-docs.mjs', repo({ ...good, 'docs/guide.md': '# Guide\n\n```sh\npnpm nonsense\n```\n' }));
        assert.match(bad.out, /runs `pnpm nonsense`/);
        const builtin = run(
            'check-docs.mjs',
            repoWithCurrentDocsIndex({
                ...good,
                'docs/guide.md': '# Guide\n\n## Getting started\n\n```sh\npnpm install\npnpm exec foo\n```\n',
            }),
        );
        assert.ok(builtin.ok, builtin.out);
    });

    it('fails for a root script that no doc mentions', () => {
        const result = run(
            'check-docs.mjs',
            repoWithCurrentDocsIndex({
                ...good,
                'package.json': { name: 'root', scripts: { test: 'x', deploy: 'y' } },
            }),
        );
        assert.match(result.out, /the script "deploy"/);

        const prefixOnly = run(
            'check-docs.mjs',
            repoWithCurrentDocsIndex({
                ...good,
                'package.json': { name: 'root', scripts: { test: 'x', readme: 'x', lint: 'x', 'lint:fix': 'x' } },
                'README.md': `${good['README.md']}\nRun \`pnpm lint:fix\`.\n`,
            }),
        );
        assert.match(prefixOnly.out, /the script "lint"/);
        assert.doesNotMatch(prefixOnly.out, /the script "lint:fix"/);
    });

    it('fails for a doc page the index does not list', () => {
        const dir = repoWithCurrentDocsIndex(good);
        fs.writeFileSync(path.join(dir, 'docs/extra.md'), '# Extra\n');
        const result = run('check-docs.mjs', dir);
        assert.match(result.out, /docs\/README\.md has stale guide and docs menus/);
    });

    it('fails for a CI job the CI doc does not list', () => {
        const ci = {
            '.github/workflows/ci.yml': [
                'jobs:',
                '    lint:',
                '        name: 📋 Lint',
                '    ship:',
                '        name: 🚀 Ship ' + '$' + '{{ x }}',
                '',
            ].join('\n'),
        };
        const docs = { 'docs/ci-and-releases.md': '# CI\n\n| 📋 Lint | always |\n' };
        const result = run(
            'check-docs.mjs',
            repoWithCurrentDocsIndex({
                ...good,
                ...ci,
                ...docs,
            }),
        );
        assert.match(result.out, /does not list the CI job "🚀 Ship"/);
        assert.doesNotMatch(result.out, /Lint/);

        const reformatted = run(
            'check-docs.mjs',
            repoWithCurrentDocsIndex({
                ...good,
                '.github/workflows/ci.yml': 'jobs:\n  cpp:\n    name: 🛠️ C++ build\n  ship:\n    name: 🚀 Ship\n',
                'docs/ci-and-releases.md': '# CI\n\n| 🛠️ C++ build | always |\n',
            }),
        );
        assert.match(reformatted.out, /does not list the CI job "🚀 Ship"/);
        assert.doesNotMatch(reformatted.out, /C\+\+/);
    });

    it('ignores scratch folders that start with an underscore', () => {
        const result = run(
            'check-docs.mjs',
            repoWithCurrentDocsIndex({ ...good, 'tools/_scratch/package.json': { name: 'scratch' } }),
        );
        assert.ok(result.ok, result.out);
    });
});

describe('package-metadata', () => {
    const files = (override = {}) => ({
        '.node-version': '24.21.0\n',
        LICENSE: 'MIT',
        'package.json': { name: 'root', description: 'Root', ...metadata('.') },
        'packages/plug/package.json': {
            name: 'plug',
            version: '0.0.0',
            description: 'A plugin',
            ...metadata('packages/plug'),
        },
        'tools/lib/package.json': {
            name: 'lib',
            description: 'A library',
            ...metadata('tools/lib'),
            sideEffects: false,
            exports: { '.': './src/index.ts' },
            main: './src/index.ts',
            module: './src/index.ts',
            types: './src/index.ts',
            files: ['src'],
            publishConfig: { access: 'public' },
            engines: { node: '>=24.21.0' },
        },
        'tools/lib/src/index.ts': '',
        ...override,
    });

    it('accepts package metadata with fields in any order', () => {
        const result = run('package-metadata.mjs', repo(files()));
        assert.ok(result.ok, result.out);
    });

    it('keeps benchmark workspace packages private', () => {
        const privatePackage = repo(
            files({
                'benchmarks/engine-comparison/package.json': {
                    name: '@pumpkin-plugins/engine-comparison',
                    private: true,
                },
            }),
        );
        assert.ok(run('package-metadata.mjs', privatePackage).ok);

        const publicPackage = repo(
            files({ 'benchmarks/engine-comparison/package.json': { name: '@pumpkin-plugins/engine-comparison' } }),
        );
        assert.match(
            run('package-metadata.mjs', publicPackage).out,
            /benchmark workspace packages must set "private": true/,
        );
    });

    it('names the missing or wrong fields', () => {
        const plug = {
            name: 'plug',
            version: '0.0.0',
            description: 'A plugin',
            ...metadata('packages/plug'),
            license: 'ISC',
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
            /"description" is 71 characters/,
        );
        const none = { name: 'plug', version: '0.0.0', ...metadata('packages/plug') };
        assert.match(
            run('package-metadata.mjs', repo(files({ 'packages/plug/package.json': none }))).out,
            /"description" is missing/,
        );
    });

    it('preserves package-specific licenses when checking and fixing plugins and tools', () => {
        for (const licenseFile of ['LICENSE', 'LICENSE.md', 'license.txt']) {
            const dir = repo(
                files({
                    [`packages/plug/${licenseFile}`]: 'GPL license',
                    [`tools/lib/${licenseFile}`]: 'Apache license',
                }),
            );
            for (const [folder, license] of [
                ['packages/plug', 'GPL-3.0-or-later'],
                ['tools/lib', 'Apache-2.0'],
            ]) {
                const file = path.join(dir, folder, 'package.json');
                const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
                pkg.license = license;
                fs.writeFileSync(file, JSON.stringify(pkg));
            }
            assert.ok(run('package-metadata.mjs', dir).ok);
            assert.ok(run('package-metadata.mjs', dir, '--fix').ok);
            assert.equal(
                JSON.parse(fs.readFileSync(path.join(dir, 'packages/plug/package.json'))).license,
                'GPL-3.0-or-later',
            );
            assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'tools/lib/package.json'))).license, 'Apache-2.0');
        }
    });

    it('wants the library fields on a tool that exports code', () => {
        const lib = {
            name: 'lib',
            description: 'A library',
            ...metadata('tools/lib'),
            exports: { '.': './src/index.ts' },
        };
        const result = run('package-metadata.mjs', repo(files({ 'tools/lib/package.json': lib })));
        assert.match(result.out, /"sideEffects" should be false/);
        assert.match(result.out, /"module" should be "\.\/src\/index\.ts"/);
    });

    it('--fix writes what can be derived and still fails on a missing description', () => {
        const dir = repo(files({ 'tools/lib/package.json': { name: 'lib', exports: { '.': './src/index.ts' } } }));
        const result = run('package-metadata.mjs', dir, '--fix');
        assert.equal(result.ok, false);
        assert.match(result.out, /"description" is missing/);
        const fixed = JSON.parse(fs.readFileSync(path.join(dir, 'tools/lib/package.json'), 'utf8'));
        assert.equal(fixed.license, 'MIT');
        assert.equal(fixed.sideEffects, false);
        assert.equal(fixed.repository.directory, 'tools/lib');
        assert.equal(fixed.homepage.endsWith('/tools/lib#readme'), true);
    });

    it('fails without a LICENSE file', () => {
        const { LICENSE: _, ...withoutLicense } = files();
        assert.match(run('package-metadata.mjs', repo(withoutLicense)).out, /LICENSE is missing/);
    });
});

describe('check-release-config', () => {
    const publicTools = { 'tools/example-tool': '@pumpkin-plugins/example-tool' };
    const files = ({ manifest = '0.0.0', releaseAs = '0.0.1', version = '0.0.0' } = {}) => ({
        'packages/plug/package.json': { name: 'plug', version },
        ...Object.fromEntries(
            Object.entries(publicTools).map(([directory, name]) => [
                `${directory}/package.json`,
                { name, version: '0.1.0', publishConfig: { access: 'public' } },
            ]),
        ),
        '.release-please-manifest.json': {
            'packages/plug': manifest,
            ...Object.fromEntries(Object.keys(publicTools).map((directory) => [directory, '0.0.0'])),
        },
        'release-please-config.json': {
            'separate-pull-requests': true,
            'always-update': true,
            'force-tag-creation': true,
            'bump-minor-pre-major': true,
            'bump-patch-for-minor-pre-major': true,
            packages: {
                'packages/plug': { component: 'plug', ...(releaseAs ? { 'release-as': releaseAs } : {}) },
                ...Object.fromEntries(
                    Object.keys(publicTools).map((directory) => [
                        directory,
                        {
                            component: path.basename(directory),
                            'component-no-space': true,
                            'pull-request-title-pattern': scopedReleaseTitlePattern,
                            'release-as': '0.1.0',
                        },
                    ]),
                ),
            },
        },
    });
    const withAction = (
        base = files(),
        { manifest = '0.0.0', releaseAs = '0.0.1', releaseType = 'simple', version = '0.0.0' } = {},
    ) => ({
        ...base,
        'actions/publish-action/action.yml': 'name: Publish\n',
        'actions/publish-action/README.md': '# Publish action\n',
        'actions/publish-action/CHANGELOG.md': '# Changelog\n',
        'actions/publish-action/version.txt': `${version}\n`,
        '.release-please-manifest.json': {
            ...base['.release-please-manifest.json'],
            'actions/publish-action': manifest,
        },
        'release-please-config.json': {
            ...base['release-please-config.json'],
            packages: {
                ...base['release-please-config.json'].packages,
                'actions/publish-action': {
                    component: 'publish-action',
                    'release-type': releaseType,
                    ...(releaseAs ? { 'release-as': releaseAs } : {}),
                },
            },
        },
    });
    const withExtension = (base = files(), { manifest = '0.0.0', releaseAs = '0.0.1', version = '0.0.0' } = {}) => ({
        ...base,
        'extensions/minecraft-terms/package.json': {
            name: 'code-spell-checker-minecraft',
            version,
            publisher: 'filiphsps',
            displayName: 'Minecraft Terms',
            engines: { vscode: '^1.100.0' },
        },
        'extensions/minecraft-terms/README.md': '# Minecraft Terms\n',
        'extensions/minecraft-terms/CHANGELOG.md': '# Changelog\n',
        '.release-please-manifest.json': {
            ...base['.release-please-manifest.json'],
            'extensions/minecraft-terms': manifest,
        },
        'release-please-config.json': {
            ...base['release-please-config.json'],
            packages: {
                ...base['release-please-config.json'].packages,
                'extensions/minecraft-terms': {
                    component: 'minecraft-terms',
                    ...(releaseAs ? { 'release-as': releaseAs } : {}),
                },
            },
        },
    });

    it('passes for an unreleased plugin that is set to release 0.0.1', () => {
        const result = run('check-release-config.mjs', repo(files()));
        assert.ok(result.ok, result.out);
    });

    it('requires the public tool release pin and package version to match its first 0.1.0 release', () => {
        const missingPin = files();
        missingPin['release-please-config.json'].packages['tools/example-tool']['release-as'] = undefined;
        assert.match(run('check-release-config.mjs', repo(missingPin)).out, /tools\/example-tool.*release-as.*0\.1\.0/);

        const mismatchedVersion = files();
        mismatchedVersion['tools/example-tool/package.json'].version = '0.1.1';
        assert.match(
            run('check-release-config.mjs', repo(mismatchedVersion)).out,
            /tools\/example-tool\/package\.json must be/,
        );
    });

    it('requires scoped public tools to include their npm scope in parseable release titles', () => {
        const missingTitlePattern = files();
        missingTitlePattern['release-please-config.json'].packages['tools/example-tool']['pull-request-title-pattern'] =
            undefined;
        assert.match(
            run('check-release-config.mjs', repo(missingTitlePattern)).out,
            /tools\/example-tool needs "pull-request-title-pattern".*@pumpkin-plugins\//,
        );

        const spacedTitleComponent = files();
        spacedTitleComponent['release-please-config.json'].packages['tools/example-tool']['component-no-space'] =
            undefined;
        assert.match(
            run('check-release-config.mjs', repo(spacedTitleComponent)).out,
            /tools\/example-tool needs "component-no-space": true/,
        );
    });

    it('retires a public tool pin only after the manifest records its first release', () => {
        const released = files();
        released['.release-please-manifest.json']['tools/example-tool'] = '0.1.0';
        released['release-please-config.json'].packages['tools/example-tool']['release-as'] = undefined;
        assert.ok(run('check-release-config.mjs', repo(released)).ok);
    });

    it('allows a plugin to pause release tracking with a reason', () => {
        const paused = files();
        paused['packages/not-ready/package.json'] = { name: 'not-ready', version: '0.0.0' };
        paused['release-please-paused.json'] = {
            'packages/not-ready': 'Not ready for its first release',
        };

        const result = run('check-release-config.mjs', repo(paused));
        assert.ok(result.ok, result.out);
    });

    it('rejects a paused plugin that remains tracked or has no reason', () => {
        const stillTracked = files();
        stillTracked['release-please-paused.json'] = { 'packages/plug': 'Not ready' };
        assert.match(
            run('check-release-config.mjs', repo(stillTracked)).out,
            /packages\/plug is paused but still listed in release-please-config\.json/,
        );

        const inManifest = files();
        inManifest['release-please-paused.json'] = { 'packages/plug': 'Not ready' };
        assert.match(
            run('check-release-config.mjs', repo(inManifest)).out,
            /packages\/plug is paused but still listed in \.release-please-manifest\.json/,
        );

        const noReason = files();
        noReason['release-please-paused.json'] = { 'packages/plug': ' ' };
        assert.match(
            run('check-release-config.mjs', repo(noReason)).out,
            /packages\/plug in release-please-paused\.json needs a non-empty reason/,
        );
    });

    it('rejects a private benchmark package in either Release Please file', () => {
        const registered = files();
        registered['benchmarks/engine-comparison/package.json'] = {
            name: '@pumpkin-plugins/engine-comparison',
            private: true,
        };
        registered['release-please-config.json'].packages['benchmarks/engine-comparison'] = {
            component: 'engine-comparison',
        };
        registered['.release-please-manifest.json']['benchmarks/engine-comparison'] = '0.0.0';

        const result = run('check-release-config.mjs', repo(registered));
        assert.equal(result.ok, false);
        assert.match(result.out, /release-please-config\.json lists benchmarks\/engine-comparison/);
        assert.match(result.out, /\.release-please-manifest\.json lists benchmarks\/engine-comparison/);
    });

    it('requires release-as 0.0.1 until the first release', () => {
        const result = run('check-release-config.mjs', repo(files({ releaseAs: null })));
        assert.match(result.out, /needs "release-as": "0\.0\.1"/);
        assert.match(
            run('check-release-config.mjs', repo(files({ releaseAs: '0.1.0' }))).out,
            /needs "release-as": "0\.0\.1"/,
        );
    });

    it('wants release-as gone once the plugin is released', () => {
        const released = run('check-release-config.mjs', repo(files({ manifest: '0.0.1', version: '0.0.1' })));
        assert.match(released.out, /remove "release-as"/);
        assert.ok(
            run('check-release-config.mjs', repo(files({ manifest: '0.0.1', version: '0.0.1', releaseAs: null }))).ok,
        );
    });

    it('still checks registration and matching versions', () => {
        const unregistered = files();
        unregistered['release-please-config.json'].packages['packages/plug'] = undefined;
        unregistered['.release-please-manifest.json']['packages/plug'] = undefined;
        assert.match(run('check-release-config.mjs', repo(unregistered)).out, /not in release-please-config\.json/);
        assert.match(
            run('check-release-config.mjs', repo(files({ manifest: '0.0.0', version: '0.0.5' }))).out,
            /must match/,
        );
    });

    it('registers actions as simple release components with matching version.txt entries', () => {
        const result = run('check-release-config.mjs', repo(withAction()));
        assert.ok(result.ok, result.out);

        const wrongType = run('check-release-config.mjs', repo(withAction(files(), { releaseType: 'node' })));
        assert.match(wrongType.out, /needs "release-type": "simple"/);

        const wrongVersion = run('check-release-config.mjs', repo(withAction(files(), { version: '0.0.2' })));
        assert.match(wrongVersion.out, /version\.txt is "0\.0\.2"/);
    });

    it('requires and retires the first-release pin for actions', () => {
        const noPin = run('check-release-config.mjs', repo(withAction(files(), { releaseAs: null })));
        assert.match(noPin.out, /actions\/publish-action has not been released yet.*release-as/);

        const released = run(
            'check-release-config.mjs',
            repo(withAction(files(), { manifest: '0.0.1', version: '0.0.1' })),
        );
        assert.match(released.out, /actions\/publish-action is released.*remove "release-as"/);

        const releasedWithoutPin = run(
            'check-release-config.mjs',
            repo(withAction(files(), { manifest: '0.0.1', releaseAs: null, version: '0.0.1' })),
        );
        assert.ok(releasedWithoutPin.ok, releasedWithoutPin.out);
    });

    it('registers VS Code extensions as independent versioned release components', () => {
        const result = run('check-release-config.mjs', repo(withExtension()));
        assert.ok(result.ok, result.out);
        assert.match(result.out, /1 extension/);

        const noPin = run('check-release-config.mjs', repo(withExtension(files(), { releaseAs: null })));
        assert.match(noPin.out, /extensions\/minecraft-terms has not been released yet.*release-as/);

        const wrongVersion = run('check-release-config.mjs', repo(withExtension(files(), { version: '0.0.2' })));
        assert.match(wrongVersion.out, /package\.json is "0\.0\.2"/);

        const released = run(
            'check-release-config.mjs',
            repo(withExtension(files(), { manifest: '0.0.1', releaseAs: null, version: '0.0.1' })),
        );
        assert.ok(released.ok, released.out);
    });

    it('requires independent release PRs that refresh even when release notes are unchanged', () => {
        const combined = files();
        combined['release-please-config.json']['separate-pull-requests'] = false;
        assert.match(run('check-release-config.mjs', repo(combined)).out, /"separate-pull-requests": true/);

        const withoutRefresh = files();
        withoutRefresh['release-please-config.json']['always-update'] = false;
        assert.match(run('check-release-config.mjs', repo(withoutRefresh)).out, /"always-update": true/);

        const withoutTag = files();
        withoutTag['release-please-config.json']['force-tag-creation'] = false;
        assert.match(run('check-release-config.mjs', repo(withoutTag)).out, /"force-tag-creation": true/);
    });

    it('requires both pre-major versioning options', () => {
        const withoutMinor = files();
        withoutMinor['release-please-config.json']['bump-minor-pre-major'] = undefined;
        assert.match(run('check-release-config.mjs', repo(withoutMinor)).out, /needs "bump-minor-pre-major": true/);

        const withoutPatch = files();
        withoutPatch['release-please-config.json']['bump-patch-for-minor-pre-major'] = undefined;
        assert.match(
            run('check-release-config.mjs', repo(withoutPatch)).out,
            /needs "bump-patch-for-minor-pre-major": true/,
        );
    });

    it('rejects component overrides that disable pre-major versioning', () => {
        const disabled = files();
        disabled['release-please-config.json'].packages['packages/plug']['bump-minor-pre-major'] = false;
        assert.match(
            run('check-release-config.mjs', repo(disabled)).out,
            /packages\/plug cannot set "bump-minor-pre-major": false/,
        );
    });
});
