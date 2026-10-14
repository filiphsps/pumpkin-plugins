import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { uploadBenchmarkChart } from './engine-comparison-chart.mjs';
import { discoverBenchmarkArtifacts } from './engine-comparison-comment.mjs';

it('uses the GitHub App token for artifact access and PR comments', () => {
    const workflow = readFileSync(
        new URL('../.github/workflows/engine-comparison-comment.yml', import.meta.url),
        'utf8',
    );

    assert.match(workflow, /uses: actions\/create-github-app-token@v3\.2\.0/);
    assert.match(workflow, /GITHUB_TOKEN: \$\{\{ steps\.app-token\.outputs\.token \}\}/);
    assert.equal((workflow.match(/github-token: \$\{\{ steps\.app-token\.outputs\.token \}\}/g) ?? []).length, 2);
    assert.match(workflow, /node scripts\/engine-comparison-comment\.mjs discover/);
    assert.match(workflow, /node scripts\/engine-comparison-chart\.mjs publish/);
    assert.ok(
        workflow.indexOf('name: 🕶️ Checkout trusted default-branch scripts') <
            workflow.indexOf('run: node scripts/engine-comparison-comment.mjs discover'),
    );
    assert.doesNotMatch(workflow, /secrets\.GITHUB_TOKEN/);
});

it('finds the current report and newest default-branch baseline before the PR base', async () => {
    const outputs = [];
    const requests = [];
    const responses = new Map([
        [
            '/repos/example/project/actions/runs/100/artifacts?per_page=100',
            { artifacts: [{ name: 'engine-comparison-report', id: 900, expired: false }] },
        ],
        [
            '/repos/example/project/actions/workflows/ci.yml/runs?branch=master&event=push&status=success&per_page=100',
            {
                workflow_runs: [
                    { id: 80, head_sha: 'recent' },
                    { id: 70, head_sha: 'ancestor' },
                ],
            },
        ],
        ['/repos/example/project/compare/recent...base', { status: 'diverged' }],
        ['/repos/example/project/compare/ancestor...base', { status: 'ahead' }],
        [
            '/repos/example/project/actions/runs/70/artifacts?per_page=100',
            { artifacts: [{ name: 'engine-comparison-report', id: 700, expired: false }] },
        ],
    ]);

    const result = await discoverBenchmarkArtifacts(
        {
            apiUrl: 'https://api.github.com',
            defaultBranch: 'master',
            pullRequestBaseSha: 'base',
            pullRequestNumber: '42',
            repository: 'example/project',
            sourceRunId: '100',
            token: 'app-token',
        },
        {
            fetchImpl: async (url, options) => {
                requests.push({ url: String(url), options });
                const pathname = new URL(url).pathname + new URL(url).search;
                assert.ok(responses.has(pathname), `Unexpected API request: ${pathname}`);
                return jsonResponse(responses.get(pathname));
            },
            writeOutput: (name, value) => outputs.push([name, value]),
        },
    );

    assert.deepEqual(result, {
        hasReport: true,
        baselineRunId: '70',
        baselineSha: 'ancestor',
        prBaseSha: 'base',
        sourceArtifactId: '900',
    });
    assert.deepEqual(outputs, [
        ['has_report', 'true'],
        ['pr_base_sha', 'base'],
        ['baseline_run_id', '70'],
        ['baseline_sha', 'ancestor'],
    ]);
    assert.ok(requests.every(({ options }) => options.headers.Authorization === 'Bearer app-token'));
});

it('skips runs without an unexpired benchmark report artifact', async () => {
    const outputs = [];
    const result = await discoverBenchmarkArtifacts(
        {
            apiUrl: 'https://api.github.com',
            defaultBranch: 'master',
            pullRequestBaseSha: 'base',
            pullRequestNumber: '42',
            repository: 'example/project',
            sourceRunId: '100',
            token: 'app-token',
        },
        {
            fetchImpl: async () =>
                jsonResponse({ artifacts: [{ name: 'engine-comparison-report', id: 900, expired: true }] }),
            writeOutput: (name, value) => outputs.push([name, value]),
        },
    );

    assert.deepEqual(result, { hasReport: false });
    assert.deepEqual(outputs, [['has_report', 'false']]);
});

it('uploads the SVG and exposes the durable attachment URL as a workflow output', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'engine-comparison-attachment-'));
    try {
        const chartPath = join(directory, 'changes.svg');
        const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>chart</text></svg>';
        writeFileSync(chartPath, svg);
        let request;
        const outputs = [];
        const chartUrl = 'https://github.com/user-attachments/assets/123e4567-e89b-12d3-a456-426614174000';

        const result = await uploadBenchmarkChart(
            {
                chartPath,
                repositoryId: '12345',
                serverUrl: 'https://github.com',
                token: 'app-token',
            },
            {
                fetchImpl: async (url, options) => {
                    request = { url: String(url), options };
                    return jsonResponse({ url: chartUrl }, 201);
                },
                writeOutput: (name, value) => outputs.push([name, value]),
            },
        );

        assert.equal(result, chartUrl);
        assert.deepEqual(outputs, [['chart_url', chartUrl]]);
        assert.equal(request.options.method, 'POST');
        assert.equal(request.options.headers.Authorization, 'Bearer app-token');
        assert.equal(request.options.headers['Content-Type'], 'application/octet-stream');
        assert.equal(request.options.headers.Accept, 'application/vnd.github+json');
        assert.deepEqual(Buffer.from(request.options.body), Buffer.from(svg));
        const uploadUrl = new URL(request.url);
        assert.equal(uploadUrl.host, 'uploads.github.com');
        assert.equal(uploadUrl.pathname, '/user-attachments/assets');
        assert.equal(uploadUrl.searchParams.get('name'), 'engine-comparison-change.svg');
        assert.equal(uploadUrl.searchParams.get('content_type'), 'image/svg+xml');
        assert.equal(uploadUrl.searchParams.get('repository_id'), '12345');
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json' },
        status,
    });
}
