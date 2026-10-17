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
        encoding: 'utf8',
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
    const fixtures = {
        '.git-blame-ignore-revs': fs.readFileSync(path.join(scripts, '../.git-blame-ignore-revs'), 'utf8'),
        'package.json': '{"name":"changed-areas-test","scripts":{}}\n',
        'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n  - "tools/*"\n',
        'tsconfig.base.json': '{}\n',
        'turbo.json': `${JSON.stringify(
            {
                globalDependencies: ['pnpm-workspace.yaml', 'tsconfig.base.json'],
                tasks: {
                    'test:integration': { dependsOn: ['build', '@test/build#build'] },
                    build: { dependsOn: ['transit', '@test/build#build'] },
                    transit: { dependsOn: ['^transit'] },
                    '@test/build#build': { dependsOn: ['transit', '@test/runtime#build'] },
                    '@test/runtime#build': { dependsOn: ['transit'] },
                },
            },
            null,
            4,
        )}\n`,
        '.github/workflows/ci.yml': [
            'name: CI',
            'jobs:',
            '    integration:',
            '        steps:',
            '            - uses: ./.github/common/bootstrap',
            '    generator:',
            '        steps:',
            '            - uses: ./.github/common/setup-static-hermes',
            '',
        ].join('\n'),
        'scripts/changed-areas.mjs': fs.readFileSync(path.join(scripts, 'changed-areas.mjs'), 'utf8'),
        'scripts/utils/ignored-commits.mjs': fs.readFileSync(path.join(scripts, 'utils/ignored-commits.mjs'), 'utf8'),
        'turbo/generators/config.mjs': 'plugin.setGenerator(() => {});\n',
        'turbo/generators/templates/plugin/package.json.hbs': '{}\n',
        'tools/build/package.json':
            '{"name":"@test/build","scripts":{"build":"true"},"dependencies":{"@test/runtime":"workspace:*"}}\n',
        'tools/static-hermes-runtime/package.json': '{"name":"@test/runtime","scripts":{"build":"true"}}\n',
    };
    const packageDirectories = new Set(
        Object.keys(files)
            .filter((file) => file.startsWith('packages/') && file.split('/').length > 2)
            .map((file) => file.split('/').slice(0, 2).join('/')),
    );
    for (const directory of packageDirectories) {
        const manifest = `${directory}/package.json`;
        if (!Object.hasOwn(files, manifest)) {
            fixtures[manifest] = `${JSON.stringify({
                name: `@test/${path.posix.basename(directory)}`,
                scripts: { 'test:integration': 'vitest run' },
            })}\n`;
        }
    }
    commit(dir, { ...fixtures, ...files });
    return dir;
}

/** Runs the script in `dir` and returns whether it passed, what it logged and the outputs it wrote. */
function run(dir, ...args) {
    const outputs = path.join(dir, 'github-output');
    const result = spawnSync('node', [path.join(dir, 'scripts/changed-areas.mjs'), ...args], {
        cwd: dir,
        env: { ...process.env, GITHUB_OUTPUT: outputs },
        encoding: 'utf8',
    });
    return {
        ok: result.status === 0,
        log: `${result.stdout}${result.stderr}`,
        outputs: fs.existsSync(outputs) ? fs.readFileSync(outputs, 'utf8') : '',
    };
}

describe('changed-areas', () => {
    it('classifies changes without installed workspace dependencies', () => {
        const dir = repo({
            'scripts/changed-areas.mjs': fs.readFileSync(path.join(scripts, 'changed-areas.mjs'), 'utf8'),
            'scripts/utils/ignored-commits.mjs': fs.readFileSync(
                path.join(scripts, 'utils/ignored-commits.mjs'),
                'utf8',
            ),
            '.git-blame-ignore-revs': fs.readFileSync(path.join(scripts, '../.git-blame-ignore-revs'), 'utf8'),
            'docs/guide.md': '# Guide\n',
        });
        const script = path.join(dir, 'scripts/changed-areas.mjs');
        const base = change(dir, { 'docs/guide.md': '# Guide\n\nMore.\n' });
        const result = spawnSync('node', [script, base, 'HEAD'], {
            cwd: dir,
            encoding: 'utf8',
        });

        assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
        assert.match(result.stdout, /No plugin or repository code/);
    });

    it('skips the code jobs for a change that is only documentation', () => {
        const dir = repo({ 'docs/guide.md': '# Guide\n', 'packages/plug/README.md': '# Plug\n' });
        const base = change(dir, { 'docs/guide.md': '# Guide\n\nMore.\n' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=false\nnative=false\nactions=[]\nactions_to_test=[]\nextensions=[]\nextensions_to_test=[]\ngenerated_readmes=false\ngenerator=false\nintegration_scope=none\nintegration_extra=\n',
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
            'code=false\nnative=false\nactions=[]\nactions_to_test=[]\nextensions=[]\nextensions_to_test=[]\ngenerated_readmes=false\ngenerator=false\nintegration_scope=none\nintegration_extra=\n',
        );
    });

    it('classifies nested component docs assets as documentation', () => {
        const dir = repo({ 'packages/plug/src/index.ts': 'export {};' });
        const base = change(dir, { 'packages/plug/docs/diagram.png': 'diagram' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=false\nnative=false\nactions=[]\nactions_to_test=[]\nextensions=[]\nextensions_to_test=[]\ngenerated_readmes=false\ngenerator=false\nintegration_scope=none\nintegration_extra=\n',
        );
    });

    it('does not schedule action tests for action-local docs assets', () => {
        const dir = repo({ 'actions/one/src/index.mjs': 'export {};' });
        const base = change(dir, { 'actions/one/docs/diagram.png': 'diagram' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=false\nnative=false\nactions=[]\nactions_to_test=[]\nextensions=[]\nextensions_to_test=[]\ngenerated_readmes=false\ngenerator=false\nintegration_scope=none\nintegration_extra=\n',
        );
    });

    it('does not schedule extension tests for extension-local docs assets', () => {
        const dir = repo({ 'extensions/one/src/extension.ts': 'export {};' });
        const base = change(dir, { 'extensions/one/docs/diagram.png': 'diagram' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=false\nnative=false\nactions=[]\nactions_to_test=[]\nextensions=[]\nextensions_to_test=[]\ngenerated_readmes=false\ngenerator=false\nintegration_scope=none\nintegration_extra=\n',
        );
    });

    it('runs the code jobs for a change to a source file', () => {
        const dir = repo({ 'packages/plug/src/index.ts': 'export {};\n' });
        const base = change(dir, { 'packages/plug/src/index.ts': 'export const a = 1;\n' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=true\nnative=false\nactions=[]\nactions_to_test=[]\nextensions=[]\nextensions_to_test=[]\ngenerated_readmes=false\ngenerator=false\nintegration_scope=affected\nintegration_extra=\nintegration_packages=["@test/plug"]\n',
        );
        assert.match(result.log, /Code: packages\/plug\/src\/index\.ts/);
    });

    it('selects the generator smoke test only for scaffold-related changes', () => {
        for (const [file, expected] of [
            ['turbo/generators/templates/plugin/src/plugin.ts.hbs', 'true'],
            ['.github/common/setup-static-hermes/action.yml', 'true'],
            ['turbo/generators/README.md', 'false'],
            ['scripts/unrelated-check.mjs', 'false'],
        ]) {
            const dir = repo({ [file]: 'export {};\n' });
            const base = change(dir, { [file]: 'export const changed = true;\n' });
            const result = run(dir, base, 'HEAD');
            assert.ok(result.ok, result.log);
            assert.match(result.outputs, new RegExp(`^generator=${expected}$`, 'm'));
        }
    });

    it('selects the engine comparison without unrelated integration suites for benchmark-only changes', () => {
        const dir = repo({ 'benchmarks/engine-comparison/src/workload.ts': 'export const value = 1;\n' });
        const base = change(dir, { 'benchmarks/engine-comparison/src/workload.ts': 'export const value = 2;\n' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=true\nnative=false\nactions=[]\nactions_to_test=[]\nextensions=[]\nextensions_to_test=[]\ngenerated_readmes=false\ngenerator=false\nintegration_scope=benchmark\nintegration_extra=\n',
        );
        assert.match(result.log, /Code: benchmarks\/engine-comparison\/src\/workload.ts/);
    });

    it('skips integration suites for unrelated repository script changes', () => {
        const dir = repo({ 'scripts/check.mjs': 'export {};\n' });
        const base = change(dir, { 'scripts/check.mjs': 'export const changed = true;\n' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=true\nnative=false\nactions=[]\nactions_to_test=[]\nextensions=[]\nextensions_to_test=[]\ngenerated_readmes=false\ngenerator=false\nintegration_scope=none\nintegration_extra=\n',
        );
    });

    it('selects affected plugin suites for a shared runtime dependency change', () => {
        const dir = repo({
            'packages/plug/package.json': JSON.stringify({
                name: '@test/plug',
                scripts: { 'test:integration': 'vitest run' },
                dependencies: { '@test/colors': 'workspace:*' },
            }),
            'tools/minecraft-colors/package.json': '{"name":"@test/colors"}\n',
            'tools/minecraft-colors/src/index.ts': 'export {};',
        });
        const base = change(dir, { 'tools/minecraft-colors/src/index.ts': 'export const changed = true;\n' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=true\nnative=false\nactions=[]\nactions_to_test=[]\nextensions=[]\nextensions_to_test=[]\ngenerated_readmes=false\ngenerator=false\nintegration_scope=affected\nintegration_extra=\nintegration_packages=["@test/colors"]\n',
        );
    });

    it('selects affected suites when a shared integration test dependency changes', () => {
        const dir = repo({
            'packages/plug/package.json': JSON.stringify({
                name: '@test/plug',
                scripts: { 'test:integration': 'vitest run' },
                devDependencies: { '@test/harness': 'workspace:*' },
            }),
            'tools/test-harness/package.json': '{"name":"@test/harness"}\n',
            'tools/test-harness/src/index.ts': 'export {};\n',
        });
        const base = change(dir, { 'tools/test-harness/src/index.ts': 'export const changed = true;\n' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=true\nnative=false\nactions=[]\nactions_to_test=[]\nextensions=[]\nextensions_to_test=[]\ngenerated_readmes=false\ngenerator=false\nintegration_scope=affected\nintegration_extra=\nintegration_packages=["@test/harness"]\n',
        );
    });

    it('selects all integration suites when their shared workflow action changes', () => {
        const dir = repo({
            '.github/common/bootstrap/action.yml': 'name: Bootstrap\n',
            '.github/common/bootstrap/src/setup.sh': 'true\n',
        });
        const base = change(dir, { '.github/common/bootstrap/src/setup.sh': 'false\n' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=true\nnative=false\nactions=[]\nactions_to_test=[]\nextensions=[]\nextensions_to_test=[]\ngenerated_readmes=false\ngenerator=false\nintegration_scope=all\nintegration_extra=\n',
        );
    });

    it('selects all plugin suites when workspace-wide build configuration changes', () => {
        const dir = repo({ 'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n' });
        const base = change(dir, { 'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n  - "tools/*"\n' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=true\nnative=false\nactions=[]\nactions_to_test=[]\nextensions=[]\nextensions_to_test=[]\ngenerated_readmes=false\ngenerator=true\nintegration_scope=all\nintegration_extra=\n',
        );
    });

    it('limits a lockfile importer change to the changed package and its dependents', () => {
        const dir = repo({
            'packages/waypoints/package.json': JSON.stringify({
                name: '@test/waypoints',
                scripts: { 'test:integration': 'vitest run' },
            }),
            'packages/upnpumpkin/package.json': JSON.stringify({
                name: '@test/upnpumpkin',
                scripts: { 'test:integration': 'vitest run' },
            }),
            'pnpm-lock.yaml': [
                'lockfileVersion: "9.0"',
                'importers:',
                '  packages/waypoints: {}',
                '  packages/upnpumpkin: {}',
                '',
            ].join('\n'),
        });
        const base = change(dir, {
            'pnpm-lock.yaml': [
                'lockfileVersion: "9.0"',
                'importers:',
                '  packages/waypoints:',
                '    dependencies:',
                '      some-dependency:',
                '        specifier: 1.0.0',
                '        version: 1.0.0',
                '  packages/upnpumpkin: {}',
                '',
            ].join('\n'),
        });
        const result = run(dir, base, 'HEAD');

        assert.ok(result.ok, result.log);
        assert.match(result.outputs, /integration_scope=affected\n/);
        assert.match(result.outputs, /integration_packages=\["@test\/waypoints"\]\n/);
        assert.doesNotMatch(result.outputs, /@test\/upnpumpkin/);
    });

    it('runs all integration suites when the root lockfile importer changes', () => {
        const dir = repo({
            'packages/plug/src/index.ts': 'export {};\n',
            'pnpm-lock.yaml': 'importers:\n  .: {}\n  packages/plug: {}\n',
        });
        const base = change(dir, { 'pnpm-lock.yaml': 'importers:\n  .:\n    dependencies: {}\n  packages/plug: {}\n' });
        const result = run(dir, base, 'HEAD');

        assert.ok(result.ok, result.log);
        assert.match(result.outputs, /integration_scope=all\n/);
        assert.doesNotMatch(result.outputs, /integration_packages=/);
    });

    it('limits catalog and lockfile importer changes to the affected integration packages', () => {
        const dir = repo({
            'packages/waypoints/package.json': JSON.stringify({
                name: '@test/waypoints',
                scripts: { 'test:integration': 'vitest run' },
                dependencies: { '@test/pumpkin-pie-api': 'workspace:*' },
            }),
            'packages/upnpumpkin/package.json': JSON.stringify({
                name: '@test/upnpumpkin',
                scripts: { 'test:integration': 'vitest run' },
            }),
            'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\ncatalog:\n  "@test/pumpkin-pie-api": workspace:*\n',
            'pnpm-lock.yaml': [
                'lockfileVersion: "9.0"',
                'importers:',
                '  packages/waypoints:',
                '    dependencies:',
                '      "@test/pumpkin-pie-api":',
                '        specifier: workspace:*',
                '        version: link:../../tools/apis/pumpkin-pie-api',
                '  packages/upnpumpkin: {}',
                '',
            ].join('\n'),
        });
        const base = change(dir, {
            'packages/waypoints/package.json': JSON.stringify({
                name: '@test/waypoints',
                scripts: { 'test:integration': 'vitest run' },
                dependencies: { '@test/pumpkin-pie-api': 'catalog:' },
            }),
            'pnpm-workspace.yaml':
                'packages:\n  - "packages/*"\ncatalog:\n  "@test/pumpkin-pie-api": workspace:*\n  "@test/new-catalog-entry": workspace:*\n',
            'pnpm-lock.yaml': [
                'lockfileVersion: "9.0"',
                'importers:',
                '  packages/waypoints:',
                '    dependencies:',
                '      "@test/pumpkin-pie-api":',
                '        specifier: catalog:',
                '        version: link:../../tools/apis/pumpkin-pie-api',
                '  packages/upnpumpkin: {}',
                '',
            ].join('\n'),
        });
        const result = run(dir, base, 'HEAD');

        assert.ok(result.ok, result.log);
        assert.match(result.outputs, /integration_scope=affected\n/);
        assert.match(result.outputs, /integration_packages=\["@test\/waypoints"\]\n/);
        assert.doesNotMatch(result.outputs, /@test\/upnpumpkin/);
    });

    it('includes bedrock-addon-manager when UPnPumpkin changes', () => {
        const dir = repo({ 'packages/upnpumpkin/src/plugin.ts': 'export {};\n' });
        const base = change(dir, { 'packages/upnpumpkin/src/plugin.ts': 'export const changed = true;\n' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=true\nnative=false\nactions=[]\nactions_to_test=[]\nextensions=[]\nextensions_to_test=[]\ngenerated_readmes=false\ngenerator=false\nintegration_scope=affected\nintegration_extra=@pumpkin-plugins/bedrock-addon-manager\nintegration_packages=["@test/upnpumpkin"]\n',
        );
    });

    it('runs the code jobs when one file among documentation changes', () => {
        const workflow = [
            'name: CI',
            'jobs:',
            '    integration:',
            '        steps:',
            '            - uses: ./.github/common/bootstrap',
            '    generator:',
            '        steps:',
            '            - uses: ./.github/common/setup-static-hermes',
            '',
        ].join('\n');
        const dir = repo({ 'docs/guide.md': '# Guide\n', '.github/workflows/ci.yml': workflow });
        const base = change(dir, {
            'docs/guide.md': '# Guide\n\nMore.\n',
            '.github/workflows/ci.yml': workflow.replace('name: CI', 'name: CI updated'),
        });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=true\nnative=false\nactions=[]\nactions_to_test=[]\nextensions=[]\nextensions_to_test=[]\ngenerated_readmes=false\ngenerator=true\nintegration_scope=all\nintegration_extra=\n',
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
            'code=true\nnative=false\nactions=[]\nactions_to_test=[]\nextensions=[]\nextensions_to_test=[]\ngenerated_readmes=false\ngenerator=false\nintegration_scope=affected\nintegration_extra=\nintegration_packages=["@test/plug"]\n',
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
            'code=true\nnative=false\nactions=[]\nactions_to_test=[]\nextensions=[]\nextensions_to_test=[]\ngenerated_readmes=false\ngenerator=false\nintegration_scope=affected\nintegration_extra=\nintegration_packages=["@test/plug"]\n',
        );
    });

    it('skips plugin code jobs and reports only the changed action', () => {
        const dir = repo({ 'actions/one/action.yml': 'name: One\n', 'actions/two/action.yml': 'name: Two\n' });
        const base = change(dir, { 'actions/two/action.yml': 'name: Two\ndescription: Updated\n' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=false\nnative=false\nactions=["two"]\nactions_to_test=["two"]\nextensions=[]\nextensions_to_test=[]\ngenerated_readmes=false\ngenerator=false\nintegration_scope=none\nintegration_extra=\n',
        );
        assert.match(result.log, /Actions to test: two/);
    });

    it('skips plugin code jobs and selects tests for the changed extension', () => {
        const dir = repo({ 'extensions/one/src/extension.ts': 'export const changed = false;\n' });
        const base = change(dir, { 'extensions/one/src/extension.ts': 'export const changed = true;\n' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=false\nnative=false\nactions=[]\nactions_to_test=[]\nextensions=["one"]\nextensions_to_test=["one"]\ngenerated_readmes=false\ngenerator=false\nintegration_scope=none\nintegration_extra=\n',
        );
        assert.match(result.log, /Extensions to test: one/);
    });

    it('reports changed actions separately when they change with plugin code', () => {
        const dir = repo({
            'actions/one/action.yml': 'name: One\n',
            'actions/two/action.yml': 'name: Two\n',
            'packages/plug/src/index.ts': 'export {};\n',
        });
        const base = change(dir, {
            'actions/two/action.yml': 'name: Two\ndescription: Updated\n',
            'packages/plug/src/index.ts': 'export const changed = true;\n',
        });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=true\nnative=false\nactions=["two"]\nactions_to_test=["two"]\nextensions=[]\nextensions_to_test=[]\ngenerated_readmes=false\ngenerator=false\nintegration_scope=affected\nintegration_extra=\nintegration_packages=["@test/plug"]\n',
        );
    });

    it('does not test an action when only its Release Please version file changes', () => {
        const dir = repo({ 'actions/one/action.yml': 'name: One\n', 'actions/one/version.txt': '0.0.0\n' });
        const base = change(dir, { 'actions/one/version.txt': '0.0.1\n' });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=false\nnative=false\nactions=["one"]\nactions_to_test=[]\nextensions=[]\nextensions_to_test=[]\ngenerated_readmes=false\ngenerator=false\nintegration_scope=none\nintegration_extra=\n',
        );
    });

    for (const deleted of [false, true]) {
        it(`tests common and all public consumers when a helper is ${deleted ? 'deleted' : 'changed'}`, () => {
            const dir = repo({ 'actions/common/src/input.mjs': 'export {};\n' });
            const base = change(dir, {
                'actions/common/src/input.mjs': deleted ? null : 'export const changed = true;\n',
            });
            const result = run(dir, base, 'HEAD');
            assert.ok(result.ok, result.log);
            assert.equal(
                result.outputs,
                'code=false\nnative=false\nactions=[]\nactions_to_test=["common","publish-to-pumpkin-market","sign-pumpkin-plugin","update-pumpkin-market-listing","verify-pumpkin-plugin"]\nextensions=[]\nextensions_to_test=[]\ngenerated_readmes=false\ngenerator=false\nintegration_scope=none\nintegration_extra=\n',
            );
        });
    }

    it('keeps common docs and version-only changes out of consumer tests and releases', () => {
        const dir = repo({ 'actions/common/README.md': '# Common\n', 'actions/common/version.txt': '1\n' });
        const base = change(dir, {
            'actions/common/README.md': '# Common\nMore\n',
            'actions/common/version.txt': '2\n',
        });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=false\nnative=false\nactions=[]\nactions_to_test=[]\nextensions=[]\nextensions_to_test=[]\ngenerated_readmes=false\ngenerator=false\nintegration_scope=none\nintegration_extra=\n',
        );
    });

    it('expands common consumers alongside mixed plugin and public action changes', () => {
        const dir = repo({
            'actions/common/src/input.mjs': 'export {};\n',
            'packages/plug/src/plugin.ts': 'export {};\n',
        });
        const base = change(dir, {
            'actions/common/src/input.mjs': 'export const changed = true;\n',
            'actions/sign-pumpkin-plugin/src/index.mjs': 'export {};\n',
            'packages/plug/src/plugin.ts': 'export const changed = true;\n',
        });
        const result = run(dir, base, 'HEAD');
        assert.ok(result.ok, result.log);
        assert.equal(
            result.outputs,
            'code=true\nnative=false\nactions=["sign-pumpkin-plugin"]\nactions_to_test=["common","publish-to-pumpkin-market","sign-pumpkin-plugin","update-pumpkin-market-listing","verify-pumpkin-plugin"]\nextensions=[]\nextensions_to_test=[]\ngenerated_readmes=false\ngenerator=false\nintegration_scope=affected\nintegration_extra=\nintegration_packages=["@test/plug"]\n',
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
            'code=false\nnative=false\nactions=[]\nactions_to_test=[]\nextensions=[]\nextensions_to_test=[]\ngenerated_readmes=true\ngenerator=false\nintegration_scope=none\nintegration_extra=\n',
        );
        assert.match(result.log, /Generated README update commit detected/);
    });
});

it('selects native platform checks and real-server integration for native source changes', () => {
    const dir = repo({ 'native/pumpkin-plus-plus/src/lib.rs': '// native\n' });
    const base = change(dir, { 'native/pumpkin-plus-plus/src/lib.rs': '// changed native\n' });
    const result = run(dir, base, 'HEAD');
    assert.equal(result.ok, true, result.log);
    assert.match(result.outputs, /native=true/);
    assert.match(result.outputs, /integration_scope=all/);
    assert.match(result.outputs, /generator=false/);
});
