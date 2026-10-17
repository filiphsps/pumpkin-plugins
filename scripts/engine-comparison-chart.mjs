import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const API_VERSION = '2022-11-28';
const CHART_BRANCH = 'benchmark-charts';
const MAX_SVG_BYTES = 10_000_000;

/** Publishes a benchmark chart on a retained branch and writes its URL as a workflow output. */
export async function uploadBenchmarkChart(
    input,
    { fetchImpl = fetch, readFile = fs.readFileSync, writeOutput = writeGitHubOutput } = {},
) {
    const token = requireString(input.token, 'GitHub App token');
    const repositoryPath = encodeRepository(input.repository);
    const apiBaseUrl = normalizeBaseUrl(input.apiUrl, 'GitHub API URL');
    const serverUrl = normalizeBaseUrl(input.serverUrl, 'GitHub server URL');
    const defaultBranch = requireString(input.defaultBranch, 'GitHub default branch');
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
    await ensureChartBranch({ apiBaseUrl, defaultBranch, fetchImpl, headers, repositoryPath });

    const result = {};
    for (const [theme, chart] of Object.entries(charts)) {
        result[theme] = await uploadChart({
            apiBaseUrl,
            chart,
            fetchImpl,
            headers,
            repositoryPath,
            serverUrl,
            sourceRunId,
            theme,
        });
        await writeOutput(`${theme}_chart_url`, result[theme]);
    }
    return result;
}

async function uploadChart({ apiBaseUrl, chart, fetchImpl, headers, repositoryPath, serverUrl, sourceRunId, theme }) {
    const filePath = `engine-comparison/${sourceRunId}-${theme}.svg`;
    const uploadUrl = apiEndpoint(apiBaseUrl, `repos/${repositoryPath}/contents/${encodePath(filePath)}`);
    const existingChart = await getExistingChart({ fetchImpl, filePath, headers, uploadUrl });
    const uploadBody = {
        branch: CHART_BRANCH,
        content: chart.toString('base64'),
        message: `ci(benchmarks): publish ${theme} chart for run ${sourceRunId}`,
    };
    if (existingChart) uploadBody.sha = existingChart.sha;

    const payload = await requestJson(
        fetchImpl,
        uploadUrl,
        {
            method: 'PUT',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(uploadBody),
        },
        'GitHub chart upload',
    );
    if (payload.content?.path !== filePath) {
        throw new Error(`GitHub ${theme} chart upload returned an unexpected file path`);
    }
    return validateDownloadUrl(payload.content.download_url, serverUrl);
}

async function getExistingChart({ fetchImpl, filePath, headers, uploadUrl }) {
    const lookupUrl = new URL(uploadUrl);
    lookupUrl.searchParams.set('ref', CHART_BRANCH);
    const response = await fetchImpl(lookupUrl, { headers });
    if (response.status === 404) return undefined;

    const payload = await readJsonResponse(response, 'GitHub existing chart lookup');
    if (typeof payload.sha !== 'string' || payload.path !== filePath) {
        throw new Error('GitHub existing chart lookup returned an unexpected file');
    }
    return { sha: payload.sha };
}

async function ensureChartBranch({ apiBaseUrl, defaultBranch, fetchImpl, headers, repositoryPath }) {
    const chartRefUrl = apiEndpoint(apiBaseUrl, `repos/${repositoryPath}/git/ref/heads/${encodeRefPath(CHART_BRANCH)}`);
    const chartRefResponse = await fetchImpl(chartRefUrl, { headers });
    if (chartRefResponse.ok) return;
    if (chartRefResponse.status !== 404) {
        await readJsonResponse(chartRefResponse, 'GitHub chart branch lookup');
    }

    const defaultRefUrl = apiEndpoint(
        apiBaseUrl,
        `repos/${repositoryPath}/git/ref/heads/${encodeRefPath(defaultBranch)}`,
    );
    const defaultRef = await requestJson(fetchImpl, defaultRefUrl, { headers }, 'GitHub default branch lookup');
    if (typeof defaultRef.object?.sha !== 'string' || !defaultRef.object.sha) {
        throw new Error('GitHub default branch lookup did not return a commit SHA');
    }

    const createRefUrl = apiEndpoint(apiBaseUrl, `repos/${repositoryPath}/git/refs`);
    const createRefResponse = await fetchImpl(createRefUrl, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: `refs/heads/${CHART_BRANCH}`, sha: defaultRef.object.sha }),
    });
    if (createRefResponse.ok) return;

    // Another workflow may create the shared chart branch after our initial lookup.
    if (createRefResponse.status === 422) {
        const concurrentRefResponse = await fetchImpl(chartRefUrl, { headers });
        if (concurrentRefResponse.ok) return;
        await readJsonResponse(concurrentRefResponse, 'GitHub chart branch lookup after creation conflict');
    }

    await readJsonResponse(createRefResponse, 'GitHub chart branch creation');
}

function encodeRepository(value) {
    const parts = requireString(value, 'GitHub repository').split('/');
    if (parts.length !== 2 || parts.some((part) => !part)) {
        throw new Error(`Invalid GitHub repository: ${value}`);
    }
    return parts.map(encodeURIComponent).join('/');
}

function encodePath(value) {
    return value.split('/').map(encodeURIComponent).join('/');
}

function encodeRefPath(value) {
    return value.split('/').map(encodeURIComponent).join('/');
}

function apiEndpoint(baseUrl, path) {
    return new URL(path, baseUrl);
}

function normalizeBaseUrl(value, description) {
    let url;
    try {
        url = new URL(requireString(value, description));
    } catch {
        throw new Error(`${description} must be a valid URL`);
    }
    if (url.protocol !== 'https:') throw new Error(`${description} must use HTTPS`);
    return new URL(url.href.endsWith('/') ? url.href : `${url.href}/`);
}

function apiHeaders(token) {
    return {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': API_VERSION,
    };
}

async function requestJson(fetchImpl, url, options, description) {
    return readJsonResponse(await fetchImpl(url, options), description);
}

async function readJsonResponse(response, description) {
    if (!response.ok) {
        const body = await response.text();
        const detail = body ? `: ${body.slice(0, 500)}` : '';
        throw new Error(`${description} failed with HTTP ${response.status}${detail}`);
    }
    try {
        return await response.json();
    } catch {
        throw new Error(`${description} returned invalid JSON`);
    }
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

function requireString(value, description) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${description} is required`);
    return value.trim();
}

function writeGitHubOutput(name, value) {
    const outputPath = process.env.GITHUB_OUTPUT;
    if (!outputPath) throw new Error('GITHUB_OUTPUT is required');
    fs.appendFileSync(outputPath, `${name}=${value}\n`);
}

function requiredEnvironment(name) {
    return requireString(process.env[name], name);
}

async function runCli() {
    if (process.argv[2] !== 'publish') throw new Error('Usage: node scripts/engine-comparison-chart.mjs publish');
    await uploadBenchmarkChart({
        apiUrl: requiredEnvironment('GITHUB_API_URL'),
        chartPaths: {
            light: requiredEnvironment('BENCHMARK_CHANGE_SVG_LIGHT'),
            dark: requiredEnvironment('BENCHMARK_CHANGE_SVG_DARK'),
        },
        defaultBranch: requiredEnvironment('DEFAULT_BRANCH'),
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
