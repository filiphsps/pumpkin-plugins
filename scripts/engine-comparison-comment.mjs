import { pathToFileURL } from 'node:url';
import { requiredEnvironment, setOutput } from './utils/ci-output.mjs';
import { apiHeaders, encodeRepository, normalizeBaseUrl, readJsonResponse } from './utils/github-api.mjs';

const REPORT_ARTIFACT = 'engine-comparison-report';
// Report artifacts expire after 90 days, which keeps the listing short; the cap only stops a runaway listing.
const MAX_REPORT_ARTIFACT_PAGES = 10;

/** Finds the current benchmark report and the newest successful matching default-branch baseline. */
export async function discoverBenchmarkArtifacts(input, { fetchImpl = fetch, writeOutput = setOutput } = {}) {
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
    const baseline = await findBaseline({
        apiBaseUrl,
        defaultBranch: input.defaultBranch,
        fetchImpl,
        headers,
        prBaseSha,
        repositoryPath,
    });
    const baselineRunId = baseline ? String(baseline.runId) : '';
    const baselineSha = baseline?.headSha ?? '';

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

/**
 * Walks the repository's report artifacts newest first and returns the first one from a successful
 * default-branch push run at or before the PR base. Listing artifacts by name skips runs that never
 * produced a report, so only candidate commits cost a compare request.
 */
async function findBaseline({ apiBaseUrl, defaultBranch, fetchImpl, headers, prBaseSha, repositoryPath }) {
    const artifactsUrl = new URL(`repos/${repositoryPath}/actions/artifacts`, apiBaseUrl);
    artifactsUrl.searchParams.set('name', REPORT_ARTIFACT);
    artifactsUrl.searchParams.set('per_page', '100');
    const comparedShas = new Map();
    const checkedRuns = new Set();
    let pageUrl = artifactsUrl;
    for (let page = 0; pageUrl && page < MAX_REPORT_ARTIFACT_PAGES; page++) {
        const response = await fetchImpl(pageUrl, { headers });
        const payload = await readJsonResponse(response, `GitHub API request ${pageUrl.pathname}`);
        for (const artifact of Array.isArray(payload.artifacts) ? payload.artifacts : []) {
            const run = artifact?.workflow_run;
            if (artifact?.name !== REPORT_ARTIFACT || artifact.expired !== false) continue;
            if (typeof run?.id !== 'number' || typeof run.head_sha !== 'string' || !run.head_sha) continue;
            if (run.head_branch !== defaultBranch || run.head_repository_id !== run.repository_id) continue;
            if (checkedRuns.has(run.id)) continue;
            checkedRuns.add(run.id);

            if (!comparedShas.has(run.head_sha)) {
                const comparison = await getJson(
                    fetchImpl,
                    new URL(
                        `repos/${repositoryPath}/compare/${encodeURIComponent(run.head_sha)}...${encodeURIComponent(prBaseSha)}`,
                        apiBaseUrl,
                    ),
                    headers,
                );
                comparedShas.set(run.head_sha, comparison.status === 'identical' || comparison.status === 'ahead');
            }
            if (!comparedShas.get(run.head_sha)) continue;

            const workflowRun = await getJson(
                fetchImpl,
                new URL(`repos/${repositoryPath}/actions/runs/${run.id}`, apiBaseUrl),
                headers,
            );
            if (workflowRun.event === 'push' && workflowRun.conclusion === 'success') {
                return { runId: run.id, headSha: run.head_sha };
            }
        }
        pageUrl = getNextPageUrl(response, artifactsUrl, apiBaseUrl);
    }
    return undefined;
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

function getNextPageUrl(response, listUrl, apiBaseUrl) {
    const linkHeader = response.headers.get('link');
    if (!linkHeader) return undefined;

    for (const link of linkHeader.split(/,(?=\s*<)/)) {
        const target = link.match(/^\s*<([^>]+)>(.*)$/);
        if (!target) continue;

        const relation = target[2].match(/(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;]+))/i);
        const relationValue = relation?.[1] ?? relation?.[2] ?? relation?.[3] ?? '';
        if (!relationValue.toLowerCase().split(/\s+/).includes('next')) continue;

        const nextPageUrl = new URL(target[1], listUrl);
        if (nextPageUrl.origin !== apiBaseUrl.origin || nextPageUrl.pathname !== listUrl.pathname) {
            throw new Error('GitHub pagination URL changed endpoint');
        }
        return nextPageUrl;
    }

    return undefined;
}

function findReportArtifact(payload) {
    if (!Array.isArray(payload.artifacts)) return undefined;
    return payload.artifacts.find((artifact) => artifact?.name === REPORT_ARTIFACT && artifact.expired === false);
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
