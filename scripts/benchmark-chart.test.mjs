import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, it } from 'node:test';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dirname, '..');
const workflow = parse(fs.readFileSync(path.join(root, '.github/workflows/engine-comparison-comment.yml'), 'utf8'));
const directories = [];
const githubExpression = (value) => `\${{ ${value} }}`;
afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-chart-'));
    directories.push(directory);
    return directory;
}

function git(directory, ...args) {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

it('uses a scoped GitHub App token for discovery, downloads, publication and comments', () => {
    const steps = workflow.jobs.report.steps;
    const tokenStep = steps.find((step) => step.id === 'app-token');
    assert.ok(tokenStep, 'Create the GitHub App token before repository operations');
    assert.equal(tokenStep.uses, 'actions/create-github-app-token@v3.2.0');
    assert.equal(tokenStep.with['client-id'], githubExpression('vars.RELEASE_APP_CLIENT_ID'));
    assert.equal(tokenStep.with['private-key'], githubExpression('secrets.RELEASE_APP_PRIVATE_KEY'));
    assert.equal(tokenStep.with['permission-actions'], 'read');
    assert.equal(tokenStep.with['permission-contents'], 'write');
    assert.equal(tokenStep.with['permission-pull-requests'], 'write');
    for (const step of steps) {
        const token = step.env?.GH_TOKEN ?? step.with?.['github-token'] ?? step.with?.token;
        if (token) assert.equal(token, githubExpression('steps.app-token.outputs.token'));
        if (step.run) assert.ok(!step.run.includes('\n'), 'Workflow logic belongs in JavaScript scripts');
    }
    const discovery = steps.find((step) => step.id === 'discover');
    assert.equal(discovery.run, 'node scripts/discover-benchmark-artifacts.mjs');
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with.ref, githubExpression('github.event.repository.default_branch'));
    assert.ok(steps.indexOf(checkout) < steps.indexOf(discovery));
    const comment = steps.find((step) => step.uses?.includes('sticky-pull-request-comment'));
    assert.equal(comment.with.GITHUB_TOKEN, githubExpression('steps.app-token.outputs.token'));
});

it('publishes SVGs on an isolated branch and retains charts from earlier runs and attempts', () => {
    const publisher = workflow.jobs.report.steps.find((step) => step.id === 'publish-chart');
    assert.ok(publisher, 'The comment needs a durable chart publication step');
    assert.equal(workflow.jobs.report.permissions.contents, 'read');
    const directory = temporaryDirectory();
    const remote = path.join(directory, 'example/repo.git');
    fs.mkdirSync(remote, { recursive: true });
    git(remote, 'init', '--bare');
    const chart = path.join(directory, 'chart.svg');
    const snapshots = [
        { run: '123', attempt: '1', svg: '<svg>first chart</svg>' },
        { run: '456', attempt: '1', svg: '<svg>second chart</svg>' },
        { run: '456', attempt: '2', svg: '<svg>retry chart</svg>' },
    ];
    for (const snapshot of snapshots) {
        fs.writeFileSync(chart, snapshot.svg);
        const result = publishChart(
            publisher,
            directory,
            chart,
            `charts/${snapshot.run}/${snapshot.attempt}/engine-comparison-change.svg`,
        );
        assert.equal(result.status, 0, result.stderr);
    }
    const files = git(remote, 'ls-tree', '-r', '--name-only', 'benchmark-reports').split('\n');
    assert.equal(files.length, snapshots.length);
    for (const snapshot of snapshots) {
        const file = `charts/${snapshot.run}/${snapshot.attempt}/engine-comparison-change.svg`;
        assert.ok(files.includes(file));
        assert.equal(git(remote, 'show', `benchmark-reports:${file}`), snapshot.svg);
    }
    const publishIndex = workflow.jobs.report.steps.indexOf(publisher);
    const commentIndex = workflow.jobs.report.steps.findIndex((step) =>
        step.uses?.includes('sticky-pull-request-comment'),
    );
    assert.ok(publishIndex < commentIndex, 'Publish the chart before posting its URL');
});

it('retries an initial rejected publication and fails when every push is rejected', () => {
    const publisher = workflow.jobs.report.steps.find((step) => step.id === 'publish-chart');
    assert.ok(publisher);
    const directory = temporaryDirectory();
    const remote = path.join(directory, 'example/repo.git');
    fs.mkdirSync(remote, { recursive: true });
    git(remote, 'init', '--bare');
    const hook = path.join(remote, 'hooks/pre-receive');
    fs.writeFileSync(
        hook,
        `#!/bin/bash
if [ ! -f rejected-once ]; then
    touch rejected-once
    exit 1
fi
`,
    );
    fs.chmodSync(hook, 0o755);
    const chart = path.join(directory, 'chart.svg');
    fs.writeFileSync(chart, '<svg>retried chart</svg>');
    const published = publishChart(publisher, directory, chart, 'charts/123/1/chart.svg');
    assert.equal(published.status, 0, published.stderr);
    assert.equal(git(remote, 'show', 'benchmark-reports:charts/123/1/chart.svg'), '<svg>retried chart</svg>');
    assert.equal(publishChart(publisher, directory, chart, 'charts/123/1/chart.svg').status, 0);

    fs.writeFileSync(hook, '#!/bin/bash\nexit 1\n');
    const rejected = publishChart(publisher, directory, chart, 'charts/456/1/chart.svg');
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Could not publish the benchmark chart/);
    assert.equal(git(remote, 'ls-tree', '-r', '--name-only', 'benchmark-reports'), 'charts/123/1/chart.svg');
});

it('preserves a concurrent chart publication when its push is rejected', () => {
    const publisher = workflow.jobs.report.steps.find((step) => step.id === 'publish-chart');
    assert.ok(publisher);
    const directory = temporaryDirectory();
    const remote = path.join(directory, 'example/repo.git');
    fs.mkdirSync(remote, { recursive: true });
    git(remote, 'init', '--bare');
    const chart = path.join(directory, 'chart.svg');
    fs.writeFileSync(chart, '<svg>first chart</svg>');
    assert.equal(publishChart(publisher, directory, chart, 'charts/123/1/chart.svg').status, 0);

    const competitor = path.join(directory, 'competitor');
    git(directory, 'clone', '--branch', 'benchmark-reports', remote, competitor);
    git(competitor, 'config', 'user.name', 'Fixture');
    git(competitor, 'config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(competitor, 'concurrent.svg'), '<svg>concurrent chart</svg>');
    git(competitor, 'add', 'concurrent.svg');
    git(competitor, 'commit', '-m', 'Publish concurrent chart');

    const hooks = path.join(directory, 'hooks');
    fs.mkdirSync(hooks);
    fs.writeFileSync(
        path.join(hooks, 'pre-push'),
        `#!/bin/bash
if [ ! -f "$RACE_MARKER" ]; then
    touch "$RACE_MARKER"
    unset GIT_DIR GIT_WORK_TREE
    git -C "$COMPETING_CHECKOUT" push origin benchmark-reports
fi
`,
    );
    fs.chmodSync(path.join(hooks, 'pre-push'), 0o755);
    fs.writeFileSync(chart, '<svg>current chart</svg>');
    const result = publishChart(publisher, directory, chart, 'charts/456/1/chart.svg', {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: hooks,
        RACE_MARKER: path.join(directory, 'race-started'),
        COMPETING_CHECKOUT: competitor,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /publication attempt 1 failed/);
    assert.equal(git(remote, 'show', 'benchmark-reports:concurrent.svg'), '<svg>concurrent chart</svg>');
    assert.equal(git(remote, 'show', 'benchmark-reports:charts/456/1/chart.svg'), '<svg>current chart</svg>');
    assert.equal(git(remote, 'show', 'benchmark-reports:charts/123/1/chart.svg'), '<svg>first chart</svg>');
});

function publishChart(publisher, directory, chart, chartPath, environment = {}) {
    assert.equal(publisher.run, 'node scripts/publish-benchmark-chart.mjs');
    return spawnSync(process.execPath, [path.join(root, 'scripts/publish-benchmark-chart.mjs')], {
        cwd: root,
        encoding: 'utf8',
        env: {
            ...process.env,
            BASH_ENV: '',
            GITHUB_SERVER_URL: directory,
            GITHUB_REPOSITORY: 'example/repo',
            RUNNER_TEMP: directory,
            BENCHMARK_CHANGE_SVG: chart,
            CHART_PATH: chartPath,
            ...environment,
        },
    });
}

it('keeps benchmark artifacts while deleting consumed CI handoffs', () => {
    const ci = parse(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'));
    const cleanup = ci.jobs.cleanup.steps[0];
    const directory = temporaryDirectory();
    const deleted = path.join(directory, 'deleted');
    const cli = path.join(directory, 'gh');
    fs.writeFileSync(
        cli,
        `#!/bin/bash
if [[ "$*" == *DELETE* ]]; then
    echo "\${@: -1}" >> "$DELETED_ARTIFACTS"
else
    printf '1\\tengine-comparison-report\\n2\\tengine-comparison-change-chart\\n3\\tplugin-wasm\\n4\\tupdate-check-fixture\\n'
fi
`,
    );
    fs.chmodSync(cli, 0o755);
    const result = spawnSync('bash', ['-c', cleanup.run], {
        encoding: 'utf8',
        env: {
            ...process.env,
            BASH_ENV: '',
            PATH: `${directory}:${process.env.PATH}`,
            DELETED_ARTIFACTS: deleted,
            GITHUB_REPOSITORY: 'example/repo',
            GITHUB_RUN_ID: '123',
            CLEAN_INTEGRATION_ARTIFACTS: 'true',
            CLEAN_RELEASE_ARTIFACTS: 'true',
            GH_TOKEN: '',
        },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(deleted), result.stdout + result.stderr);
    assert.deepEqual(fs.readFileSync(deleted, 'utf8').trim().split('\n'), [
        'repos/example/repo/actions/artifacts/3',
        'repos/example/repo/actions/artifacts/4',
    ]);
});
