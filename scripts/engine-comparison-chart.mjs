import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { requiredEnvironment, setOutput } from './utils/ci-output.mjs';
import {
    apiHeaders,
    encodePath,
    encodeRepository,
    normalizeBaseUrl,
    readJsonResponse,
    requestJson,
    requireString,
} from './utils/github-api.mjs';

const CHART_BRANCH = 'benchmark-charts';
const CHART_DIRECTORY = 'engine-comparison';
const CHART_FILE = /^(\d+)-(?:light|dark)\.svg$/;
// About 64 KB per run; older PR comments lose their chart image once their run is pruned.
const KEEP_RUNS = 100;
const MAX_PUBLISH_ATTEMPTS = 3;
const MAX_SVG_BYTES = 10_000_000;

/** Publishes the light and dark charts on the chart branch and writes their URLs as workflow outputs. */
export async function uploadBenchmarkChart(
    input,
    { fetchImpl = fetch, readFile = fs.readFileSync, writeOutput = setOutput } = {},
) {
    const token = requireString(input.token, 'GitHub App token');
    const repositoryPath = encodeRepository(input.repository);
    const apiBaseUrl = normalizeBaseUrl(input.apiUrl, 'GitHub API URL');
    const serverUrl = normalizeBaseUrl(input.serverUrl, 'GitHub server URL');
    const sourceRunId = requireString(input.sourceRunId, 'GitHub workflow run ID');
    const chartPaths = {
        light: requireString(input.chartPaths?.light, 'Light SVG chart path'),
        dark: requireString(input.chartPaths?.dark, 'Dark SVG chart path'),
    };
    if (!/^\d+$/.test(sourceRunId)) throw new Error('GitHub workflow run ID must contain only digits');

    const charts = Object.fromEntries(
        Object.entries(chartPaths).map(([theme, chartPath]) => {
            const chart = Buffer.from(readFile(chartPath));
            if (chart.byteLength === 0 || chart.byteLength > MAX_SVG_BYTES) {
                throw new Error(`${theme} SVG chart must be between 1 byte and ${MAX_SVG_BYTES} bytes`);
            }
            if (!/<svg(?:\s|>)/i.test(chart.toString('utf8'))) {
                throw new Error(`${theme} SVG chart file does not contain an <svg> element`);
            }
            return [theme, chart];
        }),
    );

    const headers = apiHeaders(token);
    const api = (path) => new URL(`repos/${repositoryPath}/${path}`, apiBaseUrl);
    const post = (path, body, description) =>
        requestJson(
            fetchImpl,
            api(path),
            { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
            description,
        );

    const ourCharts = new Map();
    for (const [theme, chart] of Object.entries(charts)) {
        const blob = await post(
            'git/blobs',
            { content: chart.toString('base64'), encoding: 'base64' },
            'GitHub chart upload',
        );
        ourCharts.set(`${sourceRunId}-${theme}.svg`, requireString(blob.sha, 'GitHub chart blob SHA'));
    }

    // The branch is rewritten as one parentless commit each time, so it never carries history.
    // A concurrent run can overwrite the ref after us; re-read it and publish again until our charts are on it.
    for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt++) {
        const headSha = await getChartBranchHead({ api, fetchImpl, headers });
        const files = headSha ? await listCharts({ api, fetchImpl, headSha, headers }) : new Map();
        for (const [name, sha] of ourCharts) files.set(name, sha);

        const tree = await post(
            'git/trees',
            {
                tree: keepNewestRuns(files, sourceRunId).map(([name, sha]) => ({
                    path: `${CHART_DIRECTORY}/${name}`,
                    mode: '100644',
                    type: 'blob',
                    sha,
                })),
            },
            'GitHub chart tree creation',
        );
        const commit = await post(
            'git/commits',
            { message: `ci(benchmarks): publish charts for run ${sourceRunId}`, tree: tree.sha, parents: [] },
            'GitHub chart commit creation',
        );

        const refResponse = headSha
            ? await fetchImpl(api(`git/refs/heads/${encodePath(CHART_BRANCH)}`), {
                  method: 'PATCH',
                  headers: { ...headers, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ sha: commit.sha, force: true }),
              })
            : await fetchImpl(api('git/refs'), {
                  method: 'POST',
                  headers: { ...headers, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ ref: `refs/heads/${CHART_BRANCH}`, sha: commit.sha }),
              });
        // 422 on creation means another run created the branch after our lookup.
        if (!headSha && refResponse.status === 422) continue;
        await readJsonResponse(refResponse, 'GitHub chart branch update');

        const urls = {};
        for (const theme of Object.keys(chartPaths)) {
            const name = `${sourceRunId}-${theme}.svg`;
            const published = await getPublishedChart({ api, fetchImpl, headers, name });
            if (published?.sha !== ourCharts.get(name)) break;
            urls[theme] = validateDownloadUrl(published.download_url, serverUrl);
        }
        if (Object.keys(urls).length < Object.keys(chartPaths).length) continue;

        for (const [theme, url] of Object.entries(urls)) await writeOutput(`${theme}_chart_url`, url);
        return urls;
    }
    throw new Error(
        `Other workflows kept replacing the ${CHART_BRANCH} branch, so the run ${sourceRunId} charts were not published`,
    );
}

async function getChartBranchHead({ api, fetchImpl, headers }) {
    const response = await fetchImpl(api(`git/ref/heads/${encodePath(CHART_BRANCH)}`), { headers });
    if (response.status === 404) return undefined;
    const ref = await readJsonResponse(response, 'GitHub chart branch lookup');
    return requireString(ref.object?.sha, 'GitHub chart branch commit SHA');
}

/** Lists chart file names and blob SHAs on the branch head, ignoring anything outside the chart directory. */
async function listCharts({ api, fetchImpl, headSha, headers }) {
    const commit = await requestJson(
        fetchImpl,
        api(`git/commits/${headSha}`),
        { headers },
        'GitHub chart commit lookup',
    );
    const root = await requestJson(
        fetchImpl,
        api(`git/trees/${requireString(commit.tree?.sha, 'GitHub chart tree SHA')}`),
        { headers },
        'GitHub chart tree lookup',
    );
    const directory = (Array.isArray(root.tree) ? root.tree : []).find(
        (entry) => entry.path === CHART_DIRECTORY && entry.type === 'tree',
    );
    if (!directory) return new Map();
    const listing = await requestJson(
        fetchImpl,
        api(`git/trees/${directory.sha}`),
        { headers },
        'GitHub chart tree lookup',
    );
    return new Map(
        (Array.isArray(listing.tree) ? listing.tree : [])
            .filter((entry) => entry.type === 'blob' && CHART_FILE.test(entry.path))
            .map((entry) => [entry.path, entry.sha]),
    );
}

/** Keeps the chart files of the newest `KEEP_RUNS` workflow runs by run ID, plus the run being published. */
function keepNewestRuns(charts, sourceRunId) {
    const runOf = (name) => Number(name.match(CHART_FILE)[1]);
    const runs = [...new Set([...charts.keys()].map(runOf))].sort((a, b) => b - a);
    const kept = new Set(runs.slice(0, KEEP_RUNS)).add(Number(sourceRunId));
    return [...charts].filter(([name]) => kept.has(runOf(name)));
}

async function getPublishedChart({ api, fetchImpl, headers, name }) {
    const url = api(`contents/${encodePath(`${CHART_DIRECTORY}/${name}`)}`);
    url.searchParams.set('ref', CHART_BRANCH);
    const response = await fetchImpl(url, { headers });
    if (response.status === 404) return undefined;
    return readJsonResponse(response, 'GitHub published chart lookup');
}

function validateDownloadUrl(value, serverUrl) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error('GitHub chart upload returned an invalid download URL');
    }

    const allowedHosts = new Set([serverUrl.host]);
    if (serverUrl.hostname === 'github.com') allowedHosts.add('raw.githubusercontent.com');
    else allowedHosts.add(`raw.${serverUrl.host}`);
    if (url.protocol !== 'https:' || !allowedHosts.has(url.host) || url.search || url.hash) {
        throw new Error('GitHub chart upload returned an unexpected download URL');
    }
    return url.href;
}

async function runCli() {
    if (process.argv[2] !== 'publish') throw new Error('Usage: node scripts/engine-comparison-chart.mjs publish');
    await uploadBenchmarkChart({
        apiUrl: requiredEnvironment('GITHUB_API_URL'),
        chartPaths: {
            light: requiredEnvironment('BENCHMARK_CHANGE_SVG_LIGHT'),
            dark: requiredEnvironment('BENCHMARK_CHANGE_SVG_DARK'),
        },
        repository: requiredEnvironment('GITHUB_REPOSITORY'),
        serverUrl: requiredEnvironment('GITHUB_SERVER_URL'),
        sourceRunId: requiredEnvironment('SOURCE_RUN_ID'),
        token: requiredEnvironment('GH_TOKEN'),
    });
    process.stdout.write('Published light and dark benchmark charts to the retained chart branch.\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    runCli().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`::error::${message.replace(/[\r\n]/g, ' ')}\n`);
        process.exitCode = 1;
    });
}
