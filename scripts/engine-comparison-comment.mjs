import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const API_VERSION = '2022-11-28';

/** Finds the current benchmark report and the newest successful matching default-branch baseline. */
export async function discoverBenchmarkArtifacts(input, { fetchImpl = fetch, writeOutput = writeGitHubOutput } = {}) {
    const repositoryPath = encodeRepository(input.repository);
    const apiBaseUrl = normalizeBaseUrl(input.apiUrl, 'GitHub API URL');
    const headers = apiHeaders(input.token);
    const sourceArtifacts = await getJson(
        fetchImpl,
        new URL(
            `repos/${repositoryPath}/actions/runs/${encodeURIComponent(input.sourceRunId)}/artifacts?per_page=100`,
            apiBaseUrl,
        ),
        headers,
    );
    const sourceArtifact = findReportArtifact(sourceArtifacts);

    if (!sourceArtifact) {
        await writeOutput('has_report', 'false');
        return { hasReport: false };
    }

    const prBaseSha =
        input.pullRequestBaseSha ||
        (await getPullRequestBaseSha({
            apiBaseUrl,
            fetchImpl,
            headers,
            pullRequestNumber: input.pullRequestNumber,
            repositoryPath,
        }));
    const workflowRunsUrl = new URL(`repos/${repositoryPath}/actions/workflows/ci.yml/runs`, apiBaseUrl);
    workflowRunsUrl.searchParams.set('branch', input.defaultBranch);
    workflowRunsUrl.searchParams.set('event', 'push');
    workflowRunsUrl.searchParams.set('status', 'success');
    workflowRunsUrl.searchParams.set('per_page', '100');
    let workflowRunsResponse = await fetchImpl(workflowRunsUrl, { headers });
    let workflowRuns = await readJsonResponse(workflowRunsResponse, `GitHub API request ${workflowRunsUrl.pathname}`);

    let baselineRunId = '';
    let baselineSha = '';
    const visitedWorkflowRunPages = new Set([workflowRunsUrl.href]);
    while (true) {
        for (const run of Array.isArray(workflowRuns.workflow_runs) ? workflowRuns.workflow_runs : []) {
            if (typeof run?.id !== 'number' || typeof run.head_sha !== 'string' || !run.head_sha) continue;

            const comparisonUrl = new URL(
                `repos/${repositoryPath}/compare/${encodeURIComponent(run.head_sha)}...${encodeURIComponent(prBaseSha)}`,
                apiBaseUrl,
            );
            const comparison = await getJson(fetchImpl, comparisonUrl, headers);
            if (comparison.status !== 'identical' && comparison.status !== 'ahead') continue;

            const baselineArtifacts = await getJson(
                fetchImpl,
                new URL(`repos/${repositoryPath}/actions/runs/${run.id}/artifacts?per_page=100`, apiBaseUrl),
                headers,
            );
            if (!findReportArtifact(baselineArtifacts)) continue;

            baselineRunId = String(run.id);
            baselineSha = run.head_sha;
            break;
        }

        if (baselineRunId) break;

        const nextPageUrl = getNextPageUrl(workflowRunsResponse, workflowRunsUrl, apiBaseUrl);
        if (!nextPageUrl || visitedWorkflowRunPages.has(nextPageUrl.href)) break;
        visitedWorkflowRunPages.add(nextPageUrl.href);
        workflowRunsResponse = await fetchImpl(nextPageUrl, { headers });
        workflowRuns = await readJsonResponse(workflowRunsResponse, `GitHub API request ${nextPageUrl.pathname}`);
    }

    await writeOutput('has_report', 'true');
    await writeOutput('pr_base_sha', prBaseSha);
    await writeOutput('baseline_run_id', baselineRunId);
    await writeOutput('baseline_sha', baselineSha);

    return {
        hasReport: true,
        baselineRunId,
        baselineSha,
        prBaseSha,
        sourceArtifactId: String(sourceArtifact.id),
    };
}

function encodeRepository(repository) {
    const parts = requireString(repository, 'GitHub repository').split('/');
    if (parts.length !== 2 || parts.some((part) => !part)) throw new Error(`Invalid GitHub repository: ${repository}`);
    return parts.map(encodeURIComponent).join('/');
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
        Authorization: `Bearer ${requireString(token, 'GitHub App token')}`,
        'X-GitHub-Api-Version': API_VERSION,
    };
}

async function getPullRequestBaseSha({ apiBaseUrl, fetchImpl, headers, pullRequestNumber, repositoryPath }) {
    const pullRequest = await getJson(
        fetchImpl,
        new URL(`repos/${repositoryPath}/pulls/${encodeURIComponent(pullRequestNumber)}`, apiBaseUrl),
        headers,
    );
    if (typeof pullRequest.base?.sha !== 'string' || !pullRequest.base.sha) {
        throw new Error(`Pull request ${pullRequestNumber} did not include a base SHA`);
    }
    return pullRequest.base.sha;
}

async function getJson(fetchImpl, url, headers) {
    const response = await fetchImpl(url, { headers });
    return readJsonResponse(response, `GitHub API request ${url.pathname}`);
}

function getNextPageUrl(response, workflowRunsUrl, apiBaseUrl) {
    const linkHeader = response.headers.get('link');
    if (!linkHeader) return undefined;

    for (const link of linkHeader.split(/,(?=\s*<)/)) {
        const target = link.match(/^\s*<([^>]+)>(.*)$/);
        if (!target) continue;

        const relation = target[2].match(/(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;]+))/i);
        const relationValue = relation?.[1] ?? relation?.[2] ?? relation?.[3] ?? '';
        if (!relationValue.toLowerCase().split(/\s+/).includes('next')) continue;

        const nextPageUrl = new URL(target[1], workflowRunsUrl);
        if (nextPageUrl.origin !== apiBaseUrl.origin || nextPageUrl.pathname !== workflowRunsUrl.pathname) {
            throw new Error('GitHub workflow-runs pagination URL changed endpoint');
        }
        return nextPageUrl;
    }

    return undefined;
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

function findReportArtifact(payload) {
    if (!Array.isArray(payload.artifacts)) return undefined;
    return payload.artifacts.find(
        (artifact) => artifact?.name === 'engine-comparison-report' && artifact.expired === false,
    );
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
    const command = process.argv[2];
    if (command === 'discover') {
        const result = await discoverBenchmarkArtifacts({
            apiUrl: requiredEnvironment('GITHUB_API_URL'),
            defaultBranch: requiredEnvironment('DEFAULT_BRANCH'),
            pullRequestBaseSha: process.env.PR_BASE_SHA ?? '',
            pullRequestNumber: requiredEnvironment('PR_NUMBER'),
            repository: requiredEnvironment('GITHUB_REPOSITORY'),
            sourceRunId: requiredEnvironment('SOURCE_RUN_ID'),
            token: requiredEnvironment('GH_TOKEN'),
        });
        process.stdout.write(
            result.hasReport ? 'Found a benchmark report artifact.\n' : 'No benchmark report artifact found.\n',
        );
        return;
    }
    throw new Error('Usage: node scripts/engine-comparison-comment.mjs discover');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    runCli().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`::error::${message.replace(/[\r\n]/g, ' ')}\n`);
        process.exitCode = 1;
    });
}
