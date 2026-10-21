// Tests for the GitHub workflows and actions: they evaluate the real `if:` conditions and run the
// real gate scripts against fixture inputs. Run with `pnpm test:scripts`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';
import { selectJobs } from './ci-gate.mjs';

const scripts = import.meta.dirname;
const dirs = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes files into a new temporary directory and returns its path. */
function repo(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflows-'));
    dirs.push(dir);
    for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), content);
    }
    return dir;
}

describe('setup-static-hermes action', () => {
    const action = parse(
        fs.readFileSync(path.join(scripts, '../.github/common/setup-static-hermes/action.yml'), 'utf8'),
    );
    const steps = action.runs.steps;
    const step = (id) => steps.find((candidate) => candidate.id === id);

    it('uses pinned host tool and toolchain versions in cache keys', () => {
        const versionScript = step('versions').run;
        assert.match(versionScript, /wasi-sdk\.lock\.json/);
        assert.match(versionScript, /toolchain-versions\.json/);
        assert.match(versionScript, /\.tools\["wit-bindgen"\]/);
        assert.match(versionScript, /\.tools\.rust/);

        const hostToolsCache = step('host-tools-cache').with;
        assert.match(hostToolsCache.path, /host-tools/);
        assert.match(hostToolsCache.key, /steps\.versions\.outputs\.cmake-version/);
        assert.match(hostToolsCache.key, /steps\.versions\.outputs\.ninja-version/);

        const witBindgenCache = step('wit-bindgen-cache').with;
        assert.match(witBindgenCache.path, /wit-bindgen-\$\{\{ steps\.versions\.outputs\.wit-bindgen-version \}\}/);
        assert.match(witBindgenCache.key, /steps\.versions\.outputs\.wit-bindgen-version/);
        assert.match(witBindgenCache.key, /steps\.versions\.outputs\.rust-toolchain-version/);

        const hermesCache = step('hermes-workspace-cache').with;
        assert.match(hermesCache.path, /\.cache\/hermes/);
        assert.match(hermesCache.key, /src\/hermes/);
        assert.match(hermesCache.key, /src\/cli\.ts/);
        assert.doesNotMatch(hermesCache.key, /bin\/toolchain-environment\.mjs/);
        assert.match(hermesCache.key, /steps\.versions\.outputs\.cmake-version/);
        assert.match(hermesCache.key, /steps\.versions\.outputs\.ninja-version/);
        assert.match(hermesCache.key, /steps\.versions\.outputs\.wasi-sdk-version/);
        assert.match(hermesCache.key, /steps\.versions\.outputs\.wit-bindgen-version/);
        assert.match(hermesCache.key, /steps\.versions\.outputs\.rust-toolchain-version/);
        assert.doesNotMatch(`${witBindgenCache.key} ${hermesCache.key}`, /wasi-sdk-34|wit-bindgen-0\.62|rust-1\.99/);
    });

    it('installs Rust and wit-bindgen only when the wit-bindgen cache misses', () => {
        const install = steps.find((candidate) => candidate.run?.includes('install wit-bindgen-cli'));
        const runsWhen = (cacheHit) =>
            runInNewContext(String(install.if ?? 'true').replace(/^\$\{\{|\}\}$/g, ''), {
                steps: { 'wit-bindgen-cache': { outputs: { 'cache-hit': cacheHit } } },
            });
        assert.equal(runsWhen('true'), false);
        assert.equal(runsWhen(''), true);
    });

    it('lets the external consumer install the Rust toolchain it checks after a wit-bindgen cache hit', () => {
        const consumer = parse(
            fs.readFileSync(path.join(scripts, '../.github/workflows/external-consumer.yml'), 'utf8'),
        );
        const check = consumer.jobs['external-consumer'].steps.find((candidate) => candidate.run?.includes('rustc'));
        const bin = repo({});
        const calls = path.join(bin, 'calls');
        const tools = { cmake: 'echo "cmake version 9.8.7"', ninja: 'echo 6.5.4', rustup: '', rustc: '', cargo: '' };
        for (const [tool, output] of Object.entries(tools)) {
            fs.writeFileSync(path.join(bin, tool), `#!/usr/bin/env bash\necho "${tool} $*" >> "${calls}"\n${output}\n`);
            fs.chmodSync(path.join(bin, tool), 0o755);
        }
        const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', check.run], {
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${bin}${path.delimiter}${process.env.PATH}`,
                RUNNER_OS: 'Linux',
                CMAKE_VERSION: '9.8.7',
                NINJA_VERSION: '6.5.4',
                RUST_VERSION: '1.2.3',
            },
        });
        assert.equal(result.status, 0, result.stderr);
        const rustCalls = fs
            .readFileSync(calls, 'utf8')
            .trim()
            .split('\n')
            .filter((call) => /^(?:rustup|rustc|cargo) /.test(call));
        assert.deepEqual(rustCalls, [
            'rustup toolchain install 1.2.3 --profile minimal',
            'rustc +1.2.3 --version',
            'cargo +1.2.3 --version',
        ]);
    });

    it('reads every toolchain version from the config files', () => {
        const workspace = repo({
            'config/wasi-sdk.lock.json': JSON.stringify({ version: '99' }),
            'config/toolchain-versions.json': JSON.stringify({
                tools: { cmake: '9.8.7', ninja: '6.5.4', 'wit-bindgen': '3.2.1', rust: '1.2.3' },
            }),
        });
        const outputFile = path.join(workspace, 'output');
        const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step('versions').run], {
            encoding: 'utf8',
            env: {
                ...process.env,
                GITHUB_WORKSPACE: workspace,
                GITHUB_OUTPUT: outputFile,
                TOOLCHAIN_CONFIG_ROOT: 'config',
            },
        });
        assert.equal(result.status, 0, result.stderr);
        const outputs = Object.fromEntries(
            fs
                .readFileSync(outputFile, 'utf8')
                .trim()
                .split('\n')
                .map((line) => line.split('=')),
        );
        assert.deepEqual(outputs, {
            'cmake-version': '9.8.7',
            'ninja-version': '6.5.4',
            'wasi-sdk-version': '99',
            'wit-bindgen-version': '3.2.1',
            'rust-toolchain-version': '1.2.3',
        });
        assert.match(
            action.outputs['rust-toolchain-version'].value,
            /steps\.versions\.outputs\.rust-toolchain-version/,
        );
    });
});

/** The publish-tools step that checks each release tag points at the commit this run built. */
const tagCheckStep = (releaseWorkflow) =>
    releaseWorkflow.jobs['publish-tools'].steps.find((step) =>
        step.run?.includes('verify-release-tag.mjs "$RELEASE_TAG"'),
    );

describe('upstream pin workflow', () => {
    const workflow = parse(
        fs.readFileSync(path.join(scripts, '../.github/workflows/update-upstream-pins.yml'), 'utf8'),
    );
    const releaseWorkflow = parse(fs.readFileSync(path.join(scripts, '../.github/workflows/release.yml'), 'utf8'));

    it('installs only the root dependencies before discovering upstream updates', () => {
        const steps = workflow.jobs.discover.steps;
        const installIndex = steps.findIndex((step) =>
            /pnpm install .*--filter pumpkin-plugins\b/.test(step.run ?? ''),
        );
        const discoverIndex = steps.findIndex((step) => step.id === 'pins');

        assert.ok(installIndex > 0, 'discover job must install the root dependencies its script imports');
        assert.ok(discoverIndex > installIndex, 'discovery must run after the dependency install');
        assert.equal(
            steps.some((step) => step.uses === './.github/common/bootstrap'),
            false,
            'discovery needs no workspace install or Turborepo cache',
        );
    });

    it('validates updates with the pinned Static Hermes toolchain that CI uses', () => {
        const steps = workflow.jobs.update.steps;
        const index = (predicate) => steps.findIndex(predicate);
        const bootstrapIndex = index((step) => step.uses === './.github/common/bootstrap');
        const toolchainIndex = index((step) => step.uses === './.github/common/setup-static-hermes');
        const applyIndex = index((step) => step.run?.includes('upstream-pins.mjs apply'));
        const validateIndex = index((step) => step.run?.includes('upstream-pins.mjs validate'));

        assert.ok(bootstrapIndex >= 0, 'the update job installs dependencies through the shared bootstrap');
        assert.ok(
            toolchainIndex > applyIndex,
            'key the Static Hermes cache to the updated pin, as its pull request does',
        );
        assert.ok(validateIndex > toolchainIndex, 'validation must use the pinned CMake and Ninja');
        for (const step of [steps[bootstrapIndex], steps[toolchainIndex]]) {
            assert.match(step.if, /NEEDS_UPDATE == 'true'/, 'set up the toolchain only when a pin changes');
        }
    });

    it('fails discovery when the Node command fails', () => {
        const steps = workflow.jobs.discover.steps;
        const discover = steps.find((step) => step.id === 'pins');
        const dir = repo({ 'bin/node': '#!/bin/sh\nexit 23\n' });
        const output = path.join(dir, 'github-output');
        fs.chmodSync(path.join(dir, 'bin/node'), 0o755);

        const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', discover.run], {
            cwd: scripts,
            env: {
                ...process.env,
                PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
                GITHUB_OUTPUT: output,
            },
            encoding: 'utf8',
        });

        assert.equal(result.status, 23, `${result.stdout}${result.stderr}`);
        assert.equal(fs.existsSync(output), false, 'failed discovery must not write an empty matrix');
    });

    it('uses the release GitHub App token so created pull requests trigger CI', () => {
        const update = workflow.jobs.update;
        const token = update.steps.find((step) => step.id === 'app-token');
        const checkout = update.steps.find((step) => step.id === 'checkout-default-branch');
        const reconcile = update.steps.find((step) => step.id === 'reconcile-upstream-update-pr-or-issue');
        const release = releaseWorkflow.jobs.release.steps;
        const releaseToken = release.find((step) => step.id === 'app-token');
        const releasePlease = release.find((step) => step.id === 'release');

        assert.ok(token, 'updater must create a GitHub App token');
        assert.equal(token.with['client-id'], releaseToken.with['client-id']);
        assert.equal(token.with['private-key'], releaseToken.with['private-key']);
        assert.equal(token.with['permission-contents'], 'write');
        assert.equal(token.with['permission-issues'], 'write');
        assert.equal(token.with['permission-pull-requests'], 'write');
        const appTokenExpression = ['$', '{{ steps.app-token.outputs.token }}'].join('');
        assert.equal(checkout.with.token, appTokenExpression);
        assert.equal(reconcile.env.GH_TOKEN, appTokenExpression);
        assert.equal(releasePlease.env.GITHUB_TOKEN, appTokenExpression);
        assert.equal(reconcile.run, 'node scripts/upstream-pins.mjs reconcile');
    });

    it('publishes registered tool releases through the caller workflow with OIDC', () => {
        const ciWorkflow = parse(fs.readFileSync(path.join(scripts, '../.github/workflows/ci.yml'), 'utf8'));
        const callerPermissions = ciWorkflow.jobs.release.permissions;
        const publish = releaseWorkflow.jobs['publish-tools'];
        assert.equal(ciWorkflow.on.workflow_dispatch.inputs.release_commit.required, true);
        assert.equal(ciWorkflow.jobs.release.with.release_commit, ['$', "{{ inputs.release_commit || '' }}"].join(''));
        assert.ok(releaseWorkflow.jobs.release.outputs.tool_paths_released);
        assert.equal(callerPermissions['id-token'], 'write');
        assert.ok(publish, 'release workflow needs a separate npm publish job for tools');
        assert.equal(publish.permissions['id-token'], 'write');
        assert.match(publish.if, /needs\.release\.outputs\.tool_paths_released/);
        assert.equal(publish.strategy, undefined, 'tool publication must run sequentially in one job');
        assert.equal(
            releaseWorkflow.jobs.release.outputs.release_metadata,
            ['$', '{{ steps.release.outputs.release_metadata }}'].join(''),
        );
        assert.equal(releaseWorkflow.jobs.release.outputs.all, undefined);
        assert.equal(
            releaseWorkflow.jobs['release-fanout-check'].env.RELEASE_METADATA,
            ['$', '{{ needs.release.outputs.release_metadata }}'].join(''),
        );
        assert.equal(
            publish.env.RELEASED_TOOL_PATHS,
            ['$', '{{ needs.release.outputs.tool_paths_released }}'].join(''),
        );
        assert.equal(publish.env.RELEASE_METADATA, ['$', '{{ needs.release.outputs.release_metadata }}'].join(''));
        const steps = publish.steps;
        assert.equal(publish.env.RELEASE_TARGET_SHA, ['$', '{{ inputs.release_commit || github.sha }}'].join(''));
        const npmSetup = steps.find((step) => step.with?.['registry-url']);
        assert.equal(
            npmSetup.with['node-version-file'],
            '.node-version',
            'npm publishing must use the repository Node',
        );
        const publishScript = steps.find((step) => step.run?.includes('scripts/publish-tool-packages.mjs'));
        assert.match(publishScript.run, /npm 11\.5\.1 or newer/);
        const tagCheck = tagCheckStep(releaseWorkflow);
        assert.ok(tagCheck, 'publish-tools must check each release tag');
        assert.ok(
            steps.indexOf(tagCheck) < steps.indexOf(publishScript),
            'tags must be checked before anything is published',
        );
    });

    it('checks the release tag against its requested commit when a newer workflow commit exists', () => {
        const tagCheck = tagCheckStep(releaseWorkflow);
        const directory = repo({
            'bin/gh': '#!/bin/sh\nprintf "commit %s\\n" "$TAG_SHA"\n',
            'bin/jq': '#!/bin/sh\nprintf "%s\\n" "$TAG_NAME"\n',
        });
        fs.chmodSync(path.join(directory, 'bin/gh'), 0o755);
        fs.chmodSync(path.join(directory, 'bin/jq'), 0o755);
        const releaseSha = 'b'.repeat(40);
        const fasterWorkflowSha = 'a'.repeat(40);
        const runGuard = (releaseTargetSha) =>
            spawnSync('bash', ['-e', '-o', 'pipefail', '-c', tagCheck.run], {
                cwd: path.join(scripts, '..'),
                env: {
                    ...process.env,
                    PATH: `${path.join(directory, 'bin')}:${process.env.PATH}`,
                    GH_REPO: 'filiphsps/pumpkin-plugins',
                    RELEASED_TOOL_PATHS: '["tools/codemod"]',
                    RELEASE_METADATA: '{}',
                    RELEASE_TARGET_SHA: releaseTargetSha,
                    TAG_NAME: 'codemod-v0.1.0',
                    TAG_SHA: releaseSha,
                    GITHUB_SHA: fasterWorkflowSha,
                },
                encoding: 'utf8',
            });

        const exactTarget = runGuard(releaseSha);
        assert.equal(exactTarget.status, 0, exactTarget.stderr);

        const fasterCommitTarget = runGuard(fasterWorkflowSha);
        assert.equal(fasterCommitTarget.status, 1);
        assert.match(fasterCommitTarget.stdout, /::error::codemod-v0\.1\.0/);
    });

    it('packages released extensions and attaches VSIX files to GitHub releases', () => {
        const publish = releaseWorkflow.jobs['publish-extensions'];
        assert.ok(releaseWorkflow.jobs.release.outputs.extension_paths_released);
        assert.ok(publish, 'release workflow needs a VSIX packaging job for extensions');
        assert.match(publish.if, /extension_paths_released/);
        assert.equal(
            publish.strategy.matrix.path,
            ['$', '{{ fromJSON(needs.release.outputs.extension_paths_released) }}'].join(''),
        );
        const steps = publish.steps.map((step) => step.run ?? '').join('\n');
        assert.match(steps, /run build/);
        assert.match(steps, /run package/);
        assert.match(steps, /gh release upload/);
        assert.match(steps, /verify-release-tag\.mjs "\$TAG"/);
        assert.match(releaseWorkflow.jobs['release-fanout-check'].steps[0].run, /extension_count/);
    });
});

// Evaluate the actual workflow conditions and run the real result check against hosted outcome fixtures.
describe('CI job selection and release prerequisites', () => {
    const ci = parse(fs.readFileSync(path.join(scripts, '../.github/workflows/ci.yml'), 'utf8'));
    const extensions = parse(fs.readFileSync(path.join(scripts, '../.github/workflows/extensions.yml'), 'utf8'));
    const startsWith = (searchString, searchValue) =>
        String(searchString ?? '')
            .toLowerCase()
            .startsWith(String(searchValue ?? '').toLowerCase());
    const evaluate = (expression, context) =>
        runInNewContext(expression.trim().replace(/^\$\{\{|\}\}$/g, ''), {
            always: () => true,
            startsWith,
            fromJSON: JSON.parse,
            github: { head_ref: 'feature/test' },
            ...context,
        });
    /** Jobs that run after classification and before the result check. */
    const checkedJobs = Object.keys(ci.jobs).filter((job) => !['changes', 'ci-result', 'release'].includes(job));

    it('fails the production build on a component above the size limit', () => {
        const buildAll = ci.jobs.build.steps.find(({ id }) => id === 'build-all');

        assert.equal(buildAll.env?.PUMPKIN_PLUGINS_FAIL_ON_SIZE_LIMIT, '1');
    });

    it('starts Static Hermes preparation as soon as changes are classified', () => {
        assert.deepEqual(ci.jobs.build.needs, ['changes']);
        assert.ok(ci.jobs.build.steps.some((step) => step.id === 'prepare-hermes'));
        assert.deepEqual(ci.jobs.lint.needs, ['changes']);
        assert.deepEqual(ci.jobs.typecheck.needs, ['changes']);
    });

    it('skips redundant workflow jobs on Release Please branches', () => {
        for (const job of ['changes', 'ci-result']) {
            const condition = ci.jobs[job].if;
            assert.equal(
                evaluate(condition, {
                    github: { head_ref: 'RELEASE-PLEASE--BRANCHES--MASTER--COMPONENTS--WAYPOINTS' },
                }),
                false,
                job,
            );
            assert.equal(evaluate(condition, { github: { head_ref: 'dev/waypoints-placeholders' } }), true, job);
        }
    });

    it('runs each job from its own entry in the selection table', () => {
        const selection = Object.fromEntries(checkedJobs.map((job, index) => [job, index % 2 === 0]));
        const needs = { changes: { outputs: { jobs: JSON.stringify(selection) } } };
        for (const job of checkedJobs) {
            assert.equal(evaluate(ci.jobs[job].if, { needs }), selection[job], job);
        }
        assert.deepEqual(Object.keys(selectJobs({}, 'push')).sort(), [...checkedJobs].sort());
    });

    it('checks every selected job except the engine comparison before releasing', () => {
        assert.deepEqual(
            [...ci.jobs['ci-result'].needs].sort(),
            ['changes', ...checkedJobs.filter((job) => job !== 'engine-comparison')].sort(),
        );
        assert.deepEqual(ci.jobs.release.needs, ['ci-result']);
    });

    it('fails the result check when a selected job did not pass', () => {
        const step = ci.jobs['ci-result'].steps.find((entry) => entry.id === 'check-results');
        const jobs = JSON.stringify(selectJobs({ code: 'true', integration_scope: 'all' }, 'push'));
        const check = (integration) =>
            spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
                cwd: path.join(scripts, '..'),
                encoding: 'utf8',
                env: {
                    ...process.env,
                    NEEDS: JSON.stringify({
                        changes: { result: 'success', outputs: { jobs } },
                        build: { result: 'success' },
                        integration: { result: integration },
                    }),
                },
            });
        assert.equal(check('success').status, 0, check('success').stderr);
        assert.equal(check('skipped').status, 1);
    });

    it('releases a push only after the result check passes, and a recovery dispatch on its own', () => {
        const release = (event, result, inputs = {}) =>
            evaluate(ci.jobs.release.if, {
                github: { event_name: event, ref: 'refs/heads/master' },
                inputs,
                needs: { 'ci-result': { result } },
            });
        assert.equal(release('push', 'success'), true);
        for (const result of ['failure', 'cancelled', 'skipped']) assert.equal(release('push', result), false);
        assert.equal(release('pull_request', 'success'), false);
        assert.equal(release('workflow_dispatch', 'skipped', { release_commit: 'a'.repeat(40) }), true);
    });

    it('runs engine comparison through its own reusable workflow', () => {
        const comparison = parse(
            fs.readFileSync(path.join(scripts, '../.github/workflows/engine-comparison.yml'), 'utf8'),
        );
        const job = ci.jobs['engine-comparison'];
        assert.ok(Object.hasOwn(comparison.on, 'workflow_call'));
        assert.equal(job.uses, './.github/workflows/engine-comparison.yml');
        assert.ok(
            Object.values(comparison.jobs).some((job) =>
                job.steps?.some((step) => step.run?.includes('compare-engines')),
            ),
        );
    });

    it('keeps the release signing key out of every CI job', () => {
        for (const [name, job] of Object.entries(ci.jobs)) {
            if (name === 'release') continue;
            assert.doesNotMatch(JSON.stringify(job), /secrets\.PLUGIN_SIGNING_KEY/, name);
        }
    });

    it('passes the selected packages to the integration run', () => {
        const integration = ci.jobs.integration;
        const integrationCommand = integration.steps.find((entry) => entry.id === 'integration-tests');
        assert.ok(integrationCommand, 'Integration job has no test command');
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-command-'));
        dirs.push(directory);
        const argsFile = path.join(directory, 'args');
        const pnpm = path.join(directory, 'pnpm');
        fs.writeFileSync(pnpm, '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$CAPTURED_ARGS"\n');
        fs.chmodSync(pnpm, 0o755);

        for (const [scope, packages, expected] of [
            [
                'affected',
                '["@pumpkin-plugins/upnpumpkin","@pumpkin-plugins/waypoints"]',
                [
                    'turbo',
                    'run',
                    'test:integration',
                    '--concurrency=2',
                    '--only',
                    '--filter=...@pumpkin-plugins/upnpumpkin',
                    '--filter=...@pumpkin-plugins/waypoints',
                ],
            ],
            ['all', '[]', ['turbo', 'run', 'test:integration', '--concurrency=2', '--only']],
        ]) {
            const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', integrationCommand.run], {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    PATH: `${directory}:${process.env.PATH}`,
                    CAPTURED_ARGS: argsFile,
                    INTEGRATION_SCOPE: scope,
                    INTEGRATION_PACKAGES: packages,
                },
            });
            assert.equal(result.status, 0, `${scope}: ${result.stderr}`);
            assert.deepEqual(fs.readFileSync(argsFile, 'utf8').trim().split('\n'), expected, scope);
        }
    });

    it('tests macOS and Windows external consumers only when the classifier asks for every platform', () => {
        const consumer = parse(
            fs.readFileSync(path.join(scripts, '../.github/workflows/external-consumer.yml'), 'utf8'),
        );
        const job = consumer.jobs['external-consumer'];
        const platforms = (full) =>
            JSON.parse(
                evaluate(ci.jobs['external-consumer'].with.platforms, {
                    needs: { changes: { outputs: { external_consumer_full: full } } },
                }),
            );
        assert.deepEqual(platforms('false'), ['Linux x64']);
        assert.deepEqual(platforms('true'), JSON.parse(consumer.on.workflow_call.inputs.platforms.default));
        for (const platform of platforms('true')) {
            const runner = evaluate(job['runs-on'], { matrix: { platform } });
            assert.ok(typeof runner === 'string' && runner.length > 0, `${platform} has no runner`);
        }
    });

    it('passes extensions into their own test and VSIX packaging workflow', () => {
        assert.equal(ci.jobs['extension-tests']?.uses, './.github/workflows/extensions.yml');
        assert.ok(extensions.on.workflow_call.inputs.extensions.required);
        assert.equal(extensions.on.workflow_call.inputs.extensions.type, 'string');
        const outputs = { extensions_to_test: '["minecraft-terms"]' };
        assert.equal(
            evaluate(ci.jobs['extension-tests'].with.extensions, { needs: { changes: { outputs } } }),
            '["minecraft-terms"]',
        );
        assert.ok(extensions.jobs.verify.steps.some((step) => step.run?.includes('run package')));
    });
});

describe('engine comparison comment workflow', () => {
    const workflow = parse(
        fs.readFileSync(path.join(scripts, '../.github/workflows/engine-comparison-comment.yml'), 'utf8'),
    );
    const job = workflow.jobs.report;
    const startsWith = (value, prefix) => String(value ?? '').startsWith(prefix);
    const runsFor = (workflowRun) =>
        runInNewContext(job.if.trim().replace(/^\$\{\{|\}\}$/g, ''), {
            startsWith,
            github: { event: { repository: { fork: false }, workflow_run: workflowRun } },
        });
    const forkRun = {
        event: 'pull_request',
        conclusion: 'success',
        head_branch: 'feature',
        head_sha: 'a'.repeat(40),
        pull_requests: [],
    };

    it('reports successful pull request runs, including runs from forks', () => {
        assert.equal(runsFor(forkRun), true, 'fork runs carry no pull_requests entry');
        assert.equal(runsFor({ ...forkRun, conclusion: 'failure' }), false);
        assert.equal(runsFor({ ...forkRun, event: 'push' }), false);
        assert.equal(runsFor({ ...forkRun, head_branch: 'release-please--branches--master' }), false);
    });

    /** Runs the pull request lookup step against a fake `gh` that returns `pulls` as the API response. */
    function findPullRequest(pulls, head) {
        const step = job.steps.find((candidate) => candidate.run?.includes('/pulls'));
        assert.ok(step, 'the job must look up the pull request for the run');
        const dir = repo({
            'bin/gh': `#!/bin/sh\nprintf '%s\\n' "$@" > "$FAKE_GH_DIR/gh-args"\ncat "$FAKE_GH_DIR/pulls.json"\n`,
            'pulls.json': JSON.stringify(pulls),
        });
        fs.chmodSync(path.join(dir, 'bin/gh'), 0o755);
        const output = path.join(dir, 'github-output');
        const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
            cwd: dir,
            env: {
                ...process.env,
                PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
                GITHUB_OUTPUT: output,
                GH_TOKEN: 'token',
                GH_REPO: 'owner/repo',
                FAKE_GH_DIR: dir,
                ...head,
            },
            encoding: 'utf8',
        });
        assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
        return {
            args: fs.readFileSync(path.join(dir, 'gh-args'), 'utf8'),
            outputs: fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '',
            dir,
        };
    }

    const head = {
        HEAD_OWNER: 'contributor',
        HEAD_REPOSITORY: 'contributor/repo',
        HEAD_BRANCH: 'feature',
        HEAD_SHA: 'a'.repeat(40),
    };
    const pull = (number, sha, repository = 'contributor/repo') => ({
        number,
        head: { sha, repo: { full_name: repository } },
        base: { sha: 'b'.repeat(40) },
    });

    it('finds a fork pull request by its head repository and commit', () => {
        const { args, outputs } = findPullRequest(
            [pull(11, 'c'.repeat(40)), pull(12, 'a'.repeat(40), 'someone/else'), pull(13, 'a'.repeat(40))],
            head,
        );
        assert.match(args, /^head=contributor:feature$/m);
        assert.equal(outputs, `number=13\nbase_sha=${'b'.repeat(40)}\n`);
    });

    it('reports nothing when no open pull request has the run commit as its head', () => {
        assert.equal(findPullRequest([pull(11, 'c'.repeat(40))], head).outputs, '');
        assert.equal(findPullRequest([], head).outputs, '');
    });

    it('passes the fork branch name to the API without running it as shell', () => {
        const { args, dir } = findPullRequest([], { ...head, HEAD_BRANCH: '$(touch pwned)`touch pwned`' });
        assert.match(args, /^head=contributor:\$\(touch pwned\)`touch pwned`$/m);
        assert.equal(fs.existsSync(path.join(dir, 'pwned')), false);
    });
});

describe('workflows in forks', () => {
    const directory = path.join(scripts, '../.github/workflows');
    /** Every workflow, keyed by the path a calling job's `uses:` gives. */
    const workflows = Object.fromEntries(
        fs
            .readdirSync(directory)
            .filter((name) => /\.ya?ml$/.test(name))
            .map((name) => [`./.github/workflows/${name}`, parse(fs.readFileSync(path.join(directory, name), 'utf8'))]),
    );
    // Events that also fire inside a fork: a sync pushes its default branch, schedules keep running, and
    // its owner can dispatch or release. A pull request from a fork runs in this repository instead.
    const forkEvents = new Set(['schedule', 'push', 'workflow_dispatch', 'workflow_run', 'release']);
    // Every run has GITHUB_TOKEN, and Test's Codecov upload doesn't fail the job without CODECOV_TOKEN.
    const notNeeded = new Set(['GITHUB_TOKEN', 'CODECOV_TOKEN']);

    /** The events a workflow runs for; a reusable workflow runs for the events of its callers. */
    const events = (file) => {
        const { on } = workflows[file];
        return (typeof on === 'object' && !Array.isArray(on) ? Object.keys(on) : [on].flat()).flatMap((event) =>
            event === 'workflow_call'
                ? Object.keys(workflows)
                      .filter((caller) => Object.values(workflows[caller].jobs).some((job) => job.uses === file))
                      .flatMap(events)
                : [event],
        );
    };

    /** Evaluates a job condition that may read only the fork flag; `undefined` when it reads anything else. */
    const withForkFlag = (condition, fork) => {
        const only = (key, value) =>
            new Proxy(
                { [key]: value },
                {
                    get: (target, name) => {
                        if (Object.hasOwn(target, name)) return target[name];
                        throw new Error(`reads ${String(name)}`);
                    },
                },
            );
        const expression = `${condition}`.trim().replace(/^\$\{\{|\}\}$/g, '');
        try {
            return runInNewContext(expression, { github: only('event', only('repository', only('fork', fork))) });
        } catch {
            return undefined;
        }
    };

    it('skips each job that needs repository secrets, the release App or GitHub Pages in a fork', () => {
        const checked = [];
        const unguarded = [];
        for (const file of Object.keys(workflows)) {
            const triggers = [...new Set(events(file))].filter((event) => forkEvents.has(event));
            if (triggers.length === 0) continue;
            for (const [name, job] of Object.entries(workflows[file].jobs)) {
                const requires = [...new Set(JSON.stringify(job).match(/(?<=\bsecrets\.)\w+/g)).difference(notNeeded)];
                // A fork shouldn't deploy the docs site, and Pages may be off there.
                if (job.steps?.some((step) => /^actions\/(?:configure|deploy)-pages@/.test(step.uses ?? ''))) {
                    requires.push('GitHub Pages');
                }
                if (requires.length === 0) continue;
                checked.push(`${file} ${name}`);
                // Skipping must follow from the fork flag alone, whatever else the run looks like.
                const condition = job.if ?? 'true';
                if (withForkFlag(condition, true) !== false || withForkFlag(condition, false) === false) {
                    unguarded.push(`${file} ${name} needs ${requires.join(', ')} on ${triggers.join(', ')}`);
                }
            }
        }
        for (const job of ['update-upstream-pins.yml update', 'docs.yml publish']) {
            assert.ok(checked.includes(`./.github/workflows/${job}`), checked.join('\n'));
        }
        assert.deepEqual(unguarded, [], "start each job's if: with !github.event.repository.fork");
    });
});

describe('third-party actions', () => {
    it('pins every action from another repository to a commit, with its release in a comment', () => {
        const root = path.join(scripts, '..');
        const files = fs.globSync(
            ['.github/workflows/*.{yml,yaml}', '.github/common/*/action.{yml,yaml}', 'actions/*/action.{yml,yaml}'],
            { cwd: root },
        );
        const unpinned = [];
        for (const file of files) {
            const source = fs.readFileSync(path.join(root, file), 'utf8');
            for (const [line, ref] of source.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+).*$/gm)) {
                if (!ref.startsWith('./') && !/@[0-9a-f]{40} # v\d\S*$/.test(line)) {
                    unpinned.push(`${file}: ${line.trim()}`);
                }
            }
        }
        assert.ok(files.includes('.github/workflows/ci.yml'));
        assert.deepEqual(unpinned, []);
    });
});
