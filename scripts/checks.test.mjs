// Tests for the repo checks (check-docs, check-release-config, package-metadata) against small
// throwaway repos. Run with `pnpm test:scripts`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';

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

    it('validates agent guidance and skill links and commands too', () => {
        const result = run(
            'check-docs.mjs',
            repo({
                ...good,
                'AGENTS.md': '# Agents\n\n[missing](.agents/skills/missing/SKILL.md)\n',
                '.agents/skills/example/SKILL.md':
                    '# Skill\n\nRun `pnpm nonexistent`. See `.agents/hooks/missing.mjs`.\n'
            })
        );
        assert.equal(result.ok, false);
        assert.match(result.out, /AGENTS\.md links to/);
        assert.match(result.out, /SKILL\.md runs `pnpm nonexistent`/);
        assert.match(result.out, /mentions \.agents\/hooks\/missing\.mjs/);
    });

    it('fails for a path in a code span that does not exist', () => {
        const result = run(
            'check-docs.mjs',
            repo({ ...good, 'docs/guide.md': '# Guide\n\n`tools/kit/src/gone.ts`\n' })
        );
        assert.match(result.out, /mentions tools\/kit\/src\/gone\.ts, which does not exist/);
    });

    it('accepts a documented plugin build output declared by its package', () => {
        const result = run(
            'check-docs.mjs',
            repo({
                ...good,
                'packages/waypoints/package.json': {
                    name: '@x/waypoints',
                    pumpkinPlugin: { output: 'build/waypoints.wasm' }
                },
                'packages/waypoints/README.md': '# @x/waypoints\n\nCopy `packages/waypoints/build/waypoints.wasm`.\n'
            })
        );
        assert.ok(result.ok, result.out);
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

    it('preserves package-specific licenses when checking and fixing plugins and tools', () => {
        for (const licenseFile of ['LICENSE', 'LICENSE.md', 'license.txt']) {
            const dir = repo(
                files({
                    [`packages/plug/${licenseFile}`]: 'GPL license',
                    [`tools/lib/${licenseFile}`]: 'Apache license'
                })
            );
            for (const [folder, license] of [
                ['packages/plug', 'GPL-3.0-or-later'],
                ['tools/lib', 'Apache-2.0']
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
                'GPL-3.0-or-later'
            );
            assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'tools/lib/package.json'))).license, 'Apache-2.0');
        }
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
            'always-update': true,
            'force-tag-creation': true,
            packages: { 'packages/plug': { component: 'plug', ...(releaseAs ? { 'release-as': releaseAs } : {}) } }
        }
    });
    const withAction = (
        base = files(),
        { manifest = '0.0.0', releaseAs = '0.0.1', releaseType = 'simple', version = '0.0.0' } = {}
    ) => ({
        ...base,
        'actions/publish-action/action.yml': 'name: Publish\n',
        'actions/publish-action/README.md': '# Publish action\n',
        'actions/publish-action/CHANGELOG.md': '# Changelog\n',
        'actions/publish-action/version.txt': `${version}\n`,
        '.release-please-manifest.json': {
            ...base['.release-please-manifest.json'],
            'actions/publish-action': manifest
        },
        'release-please-config.json': {
            ...base['release-please-config.json'],
            packages: {
                ...base['release-please-config.json'].packages,
                'actions/publish-action': {
                    component: 'publish-action',
                    'release-type': releaseType,
                    ...(releaseAs ? { 'release-as': releaseAs } : {})
                }
            }
        }
    });

    it('passes for an unreleased plugin that is set to release 0.0.1', () => {
        const result = run('check-release-config.mjs', repo(files()));
        assert.ok(result.ok, result.out);
    });

    it('allows a plugin to pause release tracking with a reason', () => {
        const paused = files();
        paused['packages/not-ready/package.json'] = { name: 'not-ready', version: '0.0.0' };
        paused['release-please-paused.json'] = {
            'packages/not-ready': 'Not ready for its first release'
        };

        const result = run('check-release-config.mjs', repo(paused));
        assert.ok(result.ok, result.out);
        assert.match(result.out, /1 plugin and 0 actions: packages\/plug; 1 paused: packages\/not-ready/);
    });

    it('rejects a paused plugin that remains tracked or has no reason', () => {
        const stillTracked = files();
        stillTracked['release-please-paused.json'] = { 'packages/plug': 'Not ready' };
        assert.match(
            run('check-release-config.mjs', repo(stillTracked)).out,
            /packages\/plug is paused but still listed in release-please-config\.json/
        );

        const inManifest = files();
        inManifest['release-please-paused.json'] = { 'packages/plug': 'Not ready' };
        assert.match(
            run('check-release-config.mjs', repo(inManifest)).out,
            /packages\/plug is paused but still listed in \.release-please-manifest\.json/
        );

        const noReason = files();
        noReason['release-please-paused.json'] = { 'packages/plug': ' ' };
        assert.match(
            run('check-release-config.mjs', repo(noReason)).out,
            /packages\/plug in release-please-paused\.json needs a non-empty reason/
        );
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

    it('registers actions as simple release components with matching version.txt entries', () => {
        const result = run('check-release-config.mjs', repo(withAction()));
        assert.ok(result.ok, result.out);
        assert.match(result.out, /1 plugin and 1 action/);

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
            repo(withAction(files(), { manifest: '0.0.1', version: '0.0.1' }))
        );
        assert.match(released.out, /actions\/publish-action is released.*remove "release-as"/);

        const releasedWithoutPin = run(
            'check-release-config.mjs',
            repo(withAction(files(), { manifest: '0.0.1', releaseAs: null, version: '0.0.1' }))
        );
        assert.ok(releasedWithoutPin.ok, releasedWithoutPin.out);
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
});

// Evaluate the actual workflow conditions and shell gate against hosted outcome fixtures.
describe('action release prerequisites', () => {
    const ci = parse(fs.readFileSync(path.join(scripts, '../.github/workflows/ci.yml'), 'utf8'));
    const actions = parse(fs.readFileSync(path.join(scripts, '../.github/workflows/actions.yml'), 'utf8'));
    const evaluate = (expression, context) =>
        runInNewContext(expression.trim().replace(/^\$\{\{|\}\}$/g, ''), { always: () => true, ...context });

    it('awaits action verification alongside every existing plugin prerequisite', () => {
        for (const job of ['changes', 'build', 'test', 'docs', 'integration', 'action-gate']) {
            assert.ok(ci.jobs.release.needs.includes(job), `Release does not await ${job}`);
        }
        assert.deepEqual(ci.jobs['action-gate'].needs, ['changes', 'action-tests']);
        assert.equal(evaluate(ci.jobs['action-gate'].if, {}), true);
    });

    it('passes the expanded matrix into the reusable action test workflow', () => {
        assert.equal(ci.jobs['action-tests']?.uses, './.github/workflows/actions.yml');
        assert.ok(actions.on.workflow_call.inputs.actions.required);
        assert.equal(actions.on.workflow_call.inputs.actions.type, 'string');
        const outputs = { actions: '[]', actions_to_test: '["common"]' };
        assert.equal(evaluate(ci.jobs['action-tests'].with.actions, { needs: { changes: { outputs } } }), '["common"]');
        assert.equal(evaluate(ci.jobs['action-tests'].if, { needs: { changes: { outputs } } }), true);
        assert.equal(
            evaluate(ci.jobs['action-tests'].if, { needs: { changes: { outputs: { actions_to_test: '[]' } } } }),
            false
        );
        const expression = actions.jobs.test.strategy.matrix.action;
        const selected = [
            'common',
            'publish-to-pumpkin-market',
            'sign-pumpkin-plugin',
            'update-pumpkin-market-listing',
            'verify-pumpkin-plugin'
        ];
        assert.deepEqual(
            Array.from(evaluate(expression, { inputs: { actions: JSON.stringify(selected) }, fromJSON: JSON.parse })),
            selected
        );
        assert.equal(evaluate(actions.jobs.test.if, { inputs: { actions: '[]' } }), false);
        assert.equal(evaluate(actions.jobs.test.if, { inputs: { actions: '["common"]' } }), true);
    });

    for (const code of ['true', 'false']) {
        for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
            it(`allows ${code === 'true' ? 'mixed' : 'action-only'} release only after a successful action gate (${result})`, () => {
                const needs = {
                    changes: { result: 'success', outputs: { code, actions: '["sign-pumpkin-plugin"]' } },
                    docs: { result: 'success' },
                    build: { result: code === 'true' ? 'success' : 'skipped' },
                    test: { result: code === 'true' ? 'success' : 'skipped' },
                    integration: { result: code === 'true' ? 'success' : 'skipped' },
                    'action-gate': { result }
                };
                assert.equal(
                    evaluate(ci.jobs.release.if, { github: { event_name: 'push' }, needs }),
                    result === 'success'
                );
            });
        }
    }

    it('runs docs/config for version-only releases and common helper changes', () => {
        for (const [actions, actions_to_test] of [
            ['["sign-pumpkin-plugin"]', '[]'],
            ['[]', '["common"]']
        ]) {
            const needs = {
                changes: { outputs: { code: 'false', actions, actions_to_test, generated_readmes: 'false' } }
            };
            assert.equal(evaluate(ci.jobs.docs.if, { needs }), true);
            assert.equal(evaluate(ci.jobs.commits.if, { needs, github: { event_name: 'pull_request' } }), true);
        }
    });

    it('preserves version-only, docs-only, common-only, and existing plugin release conditions', () => {
        for (const [code, selected, docs, expected] of [
            ['false', '["sign-pumpkin-plugin"]', 'success', true],
            ['false', '[]', 'skipped', false],
            ['false', '[]', 'success', false],
            ['true', '[]', 'success', true]
        ]) {
            const needs = {
                changes: { result: 'success', outputs: { code, actions: selected } },
                docs: { result: docs },
                build: { result: 'success' },
                test: { result: 'success' },
                integration: { result: 'success' },
                'action-gate': { result: 'success' }
            };
            assert.equal(evaluate(ci.jobs.release.if, { github: { event_name: 'push' }, needs }), expected);
            if (code === 'true') {
                for (const required of ['changes', 'build', 'test', 'docs', 'integration']) {
                    const failing = { ...needs, [required]: { ...needs[required], result: 'failure' } };
                    assert.equal(
                        evaluate(ci.jobs.release.if, { github: { event_name: 'push' }, needs: failing }),
                        false,
                        required
                    );
                }
            }
        }
    });

    it('executes the gate for required failures, cancellations, and legitimate empty matrices', () => {
        const gate = ci.jobs['action-gate'];
        assert.ok(gate, 'Action result gate is missing');
        const step = gate.steps.find((step) => step.env?.TEST_RESULT);
        assert.ok(step, 'Action result gate has no test result input');
        for (const [matrix, result, changes, expected] of [
            ['["sign-pumpkin-plugin"]', 'success', 'success', 0],
            ['["common"]', 'failure', 'success', 1],
            ['["common"]', 'cancelled', 'success', 1],
            ['["common"]', 'skipped', 'success', 1],
            ['[]', 'skipped', 'success', 0],
            ['[]', 'failure', 'success', 1],
            ['[]', 'cancelled', 'success', 1],
            ['[]', 'skipped', 'failure', 1]
        ]) {
            const outcome = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
                encoding: 'utf8',
                env: { ...process.env, ACTIONS: matrix, TEST_RESULT: result, CHANGES_RESULT: changes }
            });
            assert.equal(outcome.status, expected, `${matrix}/${result}/${changes}: ${outcome.stderr}`);
        }
    });
});
