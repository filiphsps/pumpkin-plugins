import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const API_VERSION = '2022-11-28';
const MAX_SVG_BYTES = 10_000_000;

/** Uploads the generated SVG to GitHub and writes its attachment URL as a workflow output. */
export async function uploadBenchmarkChart(
    input,
    { fetchImpl = fetch, readFile = fs.readFileSync, writeOutput = writeGitHubOutput } = {},
) {
    const token = requireString(input.token, 'GitHub App token');
    const repositoryId = requireString(input.repositoryId, 'GitHub repository ID');
    const chartPath = requireString(input.chartPath, 'SVG chart path');
    const serverUrl = normalizeBaseUrl(input.serverUrl, 'GitHub server URL');
    const chart = readFile(chartPath);
    if (chart.byteLength === 0 || chart.byteLength > MAX_SVG_BYTES) {
        throw new Error(`SVG chart must be between 1 byte and ${MAX_SVG_BYTES} bytes`);
    }
    if (!/<svg(?:\s|>)/i.test(chart.toString('utf8')))
        throw new Error('SVG chart file does not contain an <svg> element');

    const server = new URL(serverUrl);
    const uploadHost = server.hostname === 'github.com' ? 'uploads.github.com' : `uploads.${server.host}`;
    const uploadUrl = new URL(`${server.protocol}//${uploadHost}/user-attachments/assets`);
    uploadUrl.searchParams.set('name', 'engine-comparison-change.svg');
    uploadUrl.searchParams.set('content_type', 'image/svg+xml');
    uploadUrl.searchParams.set('repository_id', repositoryId);

    const response = await fetchImpl(uploadUrl, {
        method: 'POST',
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/octet-stream',
            'X-GitHub-Api-Version': API_VERSION,
        },
        body: chart,
    });
    const payload = await readJsonResponse(response);
    const assetUrl = validateAttachmentUrl(payload.url, server);
    await writeOutput('chart_url', assetUrl);
    return assetUrl;
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

async function readJsonResponse(response) {
    if (!response.ok) {
        const body = await response.text();
        const detail = body ? `: ${body.slice(0, 500)}` : '';
        throw new Error(`GitHub attachment upload failed with HTTP ${response.status}${detail}`);
    }
    try {
        return await response.json();
    } catch {
        throw new Error('GitHub attachment upload returned invalid JSON');
    }
}

function validateAttachmentUrl(value, server) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error('GitHub attachment upload returned an invalid URL');
    }
    if (
        url.protocol !== 'https:' ||
        url.host !== server.host ||
        !/^\/user-attachments\/assets\/[a-zA-Z0-9-]+$/.test(url.pathname) ||
        url.search ||
        url.hash
    ) {
        throw new Error('GitHub attachment upload returned an unexpected URL');
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
        chartPath: requiredEnvironment('BENCHMARK_CHANGE_SVG'),
        repositoryId: requiredEnvironment('GITHUB_REPOSITORY_ID'),
        serverUrl: requiredEnvironment('GITHUB_SERVER_URL'),
        token: requiredEnvironment('GH_TOKEN'),
    });
    process.stdout.write('Uploaded benchmark chart as a GitHub attachment.\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    runCli().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`::error::${message.replace(/[\r\n]/g, ' ')}\n`);
        process.exitCode = 1;
    });
}
