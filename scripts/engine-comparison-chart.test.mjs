import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it } from 'node:test';
import { uploadBenchmarkChart } from './engine-comparison-chart.mjs';

const temporaryDirectories = [];
afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const lightSvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>light</text></svg>';
const darkSvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>dark</text></svg>';

function chartInput(sourceRunId) {
    const directory = mkdtempSync(join(tmpdir(), 'engine-comparison-chart-'));
    temporaryDirectories.push(directory);
    const light = join(directory, 'changes-light.svg');
    const dark = join(directory, 'changes-dark.svg');
    writeFileSync(light, lightSvg);
    writeFileSync(dark, darkSvg);
    return {
        apiUrl: 'https://api.github.com',
        chartPaths: { light, dark },
        repository: 'example/project',
        serverUrl: 'https://github.com',
        sourceRunId,
        token: 'app-token',
    };
}

/**
 * An in-memory repository that answers the git data and contents endpoints the chart script uses.
 * `onRefUpdate` runs after each ref write, so a test can act as a concurrent workflow.
 */
function fakeRepository({ onRefUpdate = () => {} } = {}) {
    const blobs = new Map();
    const trees = new Map();
    const commits = new Map();
    const refs = new Map();
    const requests = [];
    let counter = 0;

    const store = {
        blobs,
        commits,
        refs,
        requests,
        addBlob(content) {
            const sha = createHash('sha1').update(content).digest('hex');
            blobs.set(sha, Buffer.from(content));
            return sha;
        },
        /** Stores a commit for a `{ path: blobSha }` map and returns its SHA. */
        addCommit(files, parents = []) {
            const sha = `commit${++counter}`;
            commits.set(sha, { tree: writeTree(Object.entries(files)), parents });
            return sha;
        },
        /** Lists `{ path: blobSha }` for the branch head, or undefined when the branch is missing. */
        files(branch = 'benchmark-charts') {
            const commit = commits.get(refs.get(branch));
            return commit && Object.fromEntries(listTree(commit.tree));
        },
        fetchImpl: async (url, options = {}) => {
            const method = options.method ?? 'GET';
            const requestUrl = new URL(url);
            requests.push({ method, url: requestUrl, options });
            assert.equal(options.headers.Authorization, 'Bearer app-token');
            const route = requestUrl.pathname.replace(/^\/repos\/example\/project\//, '');
            const body = options.body ? JSON.parse(options.body) : undefined;
            const param = (pattern) => route.match(pattern)?.[1];

            if (method === 'POST' && route === 'git/blobs') {
                assert.equal(body.encoding, 'base64');
                return jsonResponse({ sha: store.addBlob(Buffer.from(body.content, 'base64')) }, 201);
            }
            if (method === 'POST' && route === 'git/trees') {
                assert.equal(body.base_tree, undefined);
                return jsonResponse({ sha: writeTree(body.tree.map((entry) => [entry.path, entry.sha])) }, 201);
            }
            if (method === 'POST' && route === 'git/commits') {
                const sha = `commit${++counter}`;
                commits.set(sha, { tree: body.tree, parents: body.parents });
                return jsonResponse({ sha }, 201);
            }
            if (method === 'POST' && route === 'git/refs') {
                const branch = body.ref.replace(/^refs\/heads\//, '');
                if (refs.has(branch)) return jsonResponse({ message: 'Reference already exists' }, 422);
                refs.set(branch, body.sha);
                onRefUpdate(store);
                return jsonResponse({ object: { sha: body.sha } }, 201);
            }
            const updatedRef = method === 'PATCH' && param(/^git\/refs\/heads\/(.+)$/);
            if (updatedRef) {
                assert.equal(body.force, true);
                refs.set(decodeURIComponent(updatedRef), body.sha);
                onRefUpdate(store);
                return jsonResponse({ object: { sha: body.sha } });
            }
            const ref = param(/^git\/ref\/heads\/(.+)$/);
            if (ref) {
                const sha = refs.get(decodeURIComponent(ref));
                return sha ? jsonResponse({ object: { sha, type: 'commit' } }) : notFound();
            }
            const commitSha = param(/^git\/commits\/(.+)$/);
            if (commitSha) {
                const commit = commits.get(commitSha);
                return commit
                    ? jsonResponse({
                          sha: commitSha,
                          tree: { sha: commit.tree },
                          parents: commit.parents.map((sha) => ({ sha })),
                      })
                    : notFound();
            }
            const treeSha = param(/^git\/trees\/(.+)$/);
            if (treeSha) {
                const entries = trees.get(treeSha);
                return entries ? jsonResponse({ sha: treeSha, tree: entries, truncated: false }) : notFound();
            }
            const contentPath = method === 'GET' && param(/^contents\/(.+)$/);
            if (contentPath) {
                const branch = requestUrl.searchParams.get('ref');
                const path = decodeURIComponent(contentPath);
                const sha = store.files(branch)?.[path];
                if (!sha) return notFound();
                return jsonResponse({
                    sha,
                    path,
                    type: 'file',
                    download_url: `https://raw.githubusercontent.com/example/project/${branch}/${path}`,
                });
            }
            assert.fail(`Unexpected GitHub API request: ${method} ${requestUrl.pathname}`);
        },
    };

    function writeTree(files) {
        const children = new Map();
        const entries = [];
        for (const [path, sha] of files) {
            const [first, ...rest] = path.split('/');
            if (rest.length) children.set(first, [...(children.get(first) ?? []), [rest.join('/'), sha]]);
            else entries.push({ path: first, mode: '100644', type: 'blob', sha });
        }
        for (const [path, childFiles] of children) {
            entries.push({ path, mode: '040000', type: 'tree', sha: writeTree(childFiles) });
        }
        const sha = `tree${++counter}`;
        trees.set(sha, entries);
        return sha;
    }

    function listTree(sha, prefix = '') {
        return trees
            .get(sha)
            .flatMap((entry) =>
                entry.type === 'tree'
                    ? listTree(entry.sha, `${prefix}${entry.path}/`)
                    : [[`${prefix}${entry.path}`, entry.sha]],
            );
    }

    return store;
}

function chartUrl(sourceRunId, theme) {
    return `https://raw.githubusercontent.com/example/project/benchmark-charts/engine-comparison/${sourceRunId}-${theme}.svg`;
}

function chartFiles(store, sourceRunId) {
    return {
        [`engine-comparison/${sourceRunId}-light.svg`]: store.addBlob(`<svg>${sourceRunId} light</svg>`),
        [`engine-comparison/${sourceRunId}-dark.svg`]: store.addBlob(`<svg>${sourceRunId} dark</svg>`),
    };
}

it('creates the chart branch as a parentless commit holding only the charts', async () => {
    const repository = fakeRepository();
    const outputs = [];

    const result = await uploadBenchmarkChart(chartInput('456'), {
        fetchImpl: repository.fetchImpl,
        writeOutput: (name, value) => outputs.push([name, value]),
    });

    assert.deepEqual(result, { light: chartUrl(456, 'light'), dark: chartUrl(456, 'dark') });
    assert.deepEqual(outputs, [
        ['light_chart_url', chartUrl(456, 'light')],
        ['dark_chart_url', chartUrl(456, 'dark')],
    ]);
    const head = repository.commits.get(repository.refs.get('benchmark-charts'));
    assert.deepEqual(head.parents, []);
    const files = repository.files();
    assert.deepEqual(Object.keys(files).sort(), ['engine-comparison/456-dark.svg', 'engine-comparison/456-light.svg']);
    assert.equal(repository.blobs.get(files['engine-comparison/456-light.svg']).toString(), lightSvg);
    assert.equal(repository.blobs.get(files['engine-comparison/456-dark.svg']).toString(), darkSvg);
});

it('moves a chart branch forked from the default branch onto a parentless commit and keeps its charts', async () => {
    const repository = fakeRepository();
    const master = repository.addCommit({ 'README.md': repository.addBlob('# project') });
    repository.refs.set(
        'benchmark-charts',
        repository.addCommit(
            {
                'README.md': repository.addBlob('# project'),
                ...chartFiles(repository, 1),
                ...chartFiles(repository, 2),
            },
            [master],
        ),
    );

    await uploadBenchmarkChart(chartInput('3'), { fetchImpl: repository.fetchImpl, writeOutput: () => {} });

    assert.deepEqual(repository.commits.get(repository.refs.get('benchmark-charts')).parents, []);
    assert.deepEqual(Object.keys(repository.files()).sort(), [
        'engine-comparison/1-dark.svg',
        'engine-comparison/1-light.svg',
        'engine-comparison/2-dark.svg',
        'engine-comparison/2-light.svg',
        'engine-comparison/3-dark.svg',
        'engine-comparison/3-light.svg',
    ]);
});

it('drops the charts of the oldest runs once the branch holds 100 runs', async () => {
    const repository = fakeRepository();
    const files = {};
    for (let run = 1; run <= 100; run++) Object.assign(files, chartFiles(repository, run));
    repository.refs.set('benchmark-charts', repository.addCommit(files));

    await uploadBenchmarkChart(chartInput('101'), { fetchImpl: repository.fetchImpl, writeOutput: () => {} });

    const runs = new Set(Object.keys(repository.files()).map((path) => Number(path.match(/\/(\d+)-/)[1])));
    assert.equal(runs.size, 100);
    assert.ok(!runs.has(1));
    assert.ok(runs.has(2) && runs.has(101));
});

it('keeps a rerun of an old run even when newer runs fill the branch', async () => {
    const repository = fakeRepository();
    const files = {};
    for (let run = 11; run <= 110; run++) Object.assign(files, chartFiles(repository, run));
    repository.refs.set('benchmark-charts', repository.addCommit(files));

    const result = await uploadBenchmarkChart(chartInput('10'), {
        fetchImpl: repository.fetchImpl,
        writeOutput: () => {},
    });

    assert.deepEqual(result, { light: chartUrl(10, 'light'), dark: chartUrl(10, 'dark') });
});

it('replaces the charts of a rerun workflow', async () => {
    const repository = fakeRepository();
    repository.refs.set(
        'benchmark-charts',
        repository.addCommit({ ...chartFiles(repository, 789), ...chartFiles(repository, 5) }),
    );

    const result = await uploadBenchmarkChart(chartInput('789'), {
        fetchImpl: repository.fetchImpl,
        writeOutput: () => {},
    });

    assert.deepEqual(result, { light: chartUrl(789, 'light'), dark: chartUrl(789, 'dark') });
    const files = repository.files();
    assert.equal(Object.keys(files).length, 4);
    assert.equal(repository.blobs.get(files['engine-comparison/789-light.svg']).toString(), lightSvg);
    assert.equal(repository.blobs.get(files['engine-comparison/789-dark.svg']).toString(), darkSvg);
});

it('publishes again when another workflow replaces the branch without these charts', async () => {
    let replaced = false;
    const repository = fakeRepository({
        onRefUpdate(store) {
            if (replaced) return;
            replaced = true;
            store.refs.set('benchmark-charts', store.addCommit(chartFiles(store, 7)));
        },
    });

    const result = await uploadBenchmarkChart(chartInput('8'), {
        fetchImpl: repository.fetchImpl,
        writeOutput: () => {},
    });

    assert.deepEqual(result, { light: chartUrl(8, 'light'), dark: chartUrl(8, 'dark') });
    assert.deepEqual(Object.keys(repository.files()).sort(), [
        'engine-comparison/7-dark.svg',
        'engine-comparison/7-light.svg',
        'engine-comparison/8-dark.svg',
        'engine-comparison/8-light.svg',
    ]);
});

it('fails instead of reporting charts that other workflows keep removing', async () => {
    const repository = fakeRepository({
        onRefUpdate(store) {
            store.refs.set('benchmark-charts', store.addCommit(chartFiles(store, 7)));
        },
    });

    await assert.rejects(
        uploadBenchmarkChart(chartInput('8'), { fetchImpl: repository.fetchImpl, writeOutput: () => {} }),
        /benchmark-charts/,
    );
});

function notFound() {
    return jsonResponse({ message: 'Not Found' }, 404);
}

function jsonResponse(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json', ...headers },
        status,
    });
}
