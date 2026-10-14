import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';

/** Finds the current report and the newest successful benchmark at or before the PR base. */
export function discoverBenchmarkArtifacts(
    { repository, sourceRunId, prNumber, baseSha, defaultBranch },
    api = githubApi,
) {
    const hasReport = (runId) =>
        api(`repos/${repository}/actions/runs/${runId}/artifacts`).artifacts.some(
            (artifact) => artifact.name === 'engine-comparison-report' && artifact.expired === false,
        );
    if (!hasReport(sourceRunId)) return { has_report: false };

    const resolvedBaseSha = baseSha || api(`repos/${repository}/pulls/${prNumber}`).base.sha;
    const runs = api(
        `repos/${repository}/actions/workflows/ci.yml/runs?branch=${encodeURIComponent(defaultBranch)}&event=push&status=success&per_page=100`,
    ).workflow_runs;
    for (const run of runs) {
        const { status } = api(`repos/${repository}/compare/${run.head_sha}...${resolvedBaseSha}`);
        if (status !== 'identical' && status !== 'ahead') continue;
        if (hasReport(run.id)) {
            return {
                has_report: true,
                pr_base_sha: resolvedBaseSha,
                baseline_run_id: run.id,
                baseline_sha: run.head_sha,
            };
        }
    }
    return { has_report: true, pr_base_sha: resolvedBaseSha, baseline_run_id: '', baseline_sha: '' };
}

function githubApi(endpoint) {
    return JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8' }));
}

function requiredEnvironment(name) {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    new Command()
        .name('discover-benchmark-artifacts')
        .description('Find reports for the trusted benchmark comment workflow.')
        .action(() => {
            const outputs = discoverBenchmarkArtifacts({
                repository: requiredEnvironment('GH_REPOSITORY'),
                sourceRunId: requiredEnvironment('SOURCE_RUN_ID'),
                prNumber: requiredEnvironment('PR_NUMBER'),
                baseSha: process.env.PR_BASE_SHA,
                defaultBranch: requiredEnvironment('DEFAULT_BRANCH'),
            });
            fs.appendFileSync(
                requiredEnvironment('GITHUB_OUTPUT'),
                Object.entries(outputs)
                    .map(([key, value]) => `${key}=${value}\n`)
                    .join(''),
            );
            if (!outputs.has_report) console.log('CI completed without an engine-comparison report artifact.');
        })
        .parse();
}
