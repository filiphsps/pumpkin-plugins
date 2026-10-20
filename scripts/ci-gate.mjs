// Decides which CI jobs a change needs and checks that they passed. The `changes` job runs
// `select` to write the `jobs` output that each job's `if:` reads, and the `ci-result` job runs
// `check` on every job's result. See the Jobs table in docs/ci-and-releases.md.
import { appendFileSync } from 'node:fs';

/**
 * Maps each CI job id in ci.yml to whether a change needs it, from the `changes` job's classifier
 * outputs and the triggering event name.
 */
export function selectJobs(outputs, event) {
    const code = outputs.code === 'true';
    const full = outputs.skip_expensive_checks !== 'true';
    const actionCode = outputs.actions_to_test !== '[]';
    const extensionCode = outputs.extensions_to_test !== '[]';
    const touched =
        code ||
        actionCode ||
        extensionCode ||
        outputs.actions !== '[]' ||
        outputs.extensions !== '[]' ||
        outputs.generated_readmes === 'true';
    return {
        commits: event === 'pull_request' && touched,
        // Biome covers actions/, so action code changes run lint; the coverage run tests them.
        lint: code || actionCode,
        typecheck: code,
        test: (code || actionCode) && full,
        'extension-tests': extensionCode,
        // Docs-only pushes still run docs and config, so the release after it can refresh release PRs.
        docs: touched || (event === 'push' && outputs.config_only !== 'true'),
        build: code,
        'external-consumer': code && full,
        // Default-branch pushes keep a baseline that pull request comparisons are measured against.
        'engine-comparison': full && (outputs.benchmark === 'true' || (event === 'push' && code)),
        integration: full && (outputs.integration_scope === 'affected' || outputs.integration_scope === 'all'),
        generator: full && outputs.generator === 'true',
    };
}

/**
 * Lists why a CI run must not count as passing, given the `needs` context of the `ci-result` job.
 * A selected job must succeed, and no job may fail or be cancelled.
 */
export function checkResults(needs) {
    if (needs.changes?.result !== 'success') {
        return [`Change classification did not succeed: ${needs.changes?.result ?? 'missing'}`];
    }
    const selected = JSON.parse(needs.changes.outputs.jobs);
    const problems = [];
    for (const [job, { result }] of Object.entries(needs)) {
        if (job === 'changes') continue;
        if (!Object.hasOwn(selected, job)) problems.push(`${job} has no selection rule in scripts/ci-gate.mjs`);
        else if (selected[job] && result !== 'success') problems.push(`${job} was required but ended as ${result}`);
        else if (result === 'failure' || result === 'cancelled') problems.push(`${job} ended as ${result}`);
    }
    return problems;
}

if (import.meta.main) {
    const [command] = process.argv.slice(2);
    if (command === 'select') {
        const selected = selectJobs(JSON.parse(process.env.CHANGES ?? '{}'), process.env.GITHUB_EVENT_NAME);
        for (const [job, needed] of Object.entries(selected)) console.log(`${job}: ${needed ? 'selected' : 'skipped'}`);
        if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `jobs=${JSON.stringify(selected)}\n`);
    } else if (command === 'check') {
        const problems = checkResults(JSON.parse(process.env.NEEDS ?? '{}'));
        for (const problem of problems) console.error(problem);
        if (problems.length) process.exit(1);
        console.log('Every selected CI job passed.');
    } else {
        console.error('Usage: ci-gate.mjs select|check');
        process.exit(1);
    }
}
