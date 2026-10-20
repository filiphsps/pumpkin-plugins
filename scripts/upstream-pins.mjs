import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';

const DEFAULT_CATALOG = '.github/upstream-pins.json';
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

/** Discovers the latest configured branch tip for each pinned upstream source. */
export async function discoverUpstreamPins({
    workspaceRoot = process.cwd(),
    catalogPath = DEFAULT_CATALOG,
    lookupRef = lookupGitRef,
}) {
    const sources = readCatalog(workspaceRoot, catalogPath);
    return Promise.all(
        sources.map(async (source) => {
            const pinPath = path.join(workspaceRoot, source.pinFile);
            const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
            const repository = pin.repository;
            const branch = pin.branch;
            const current = pin[source.pinField];
            if (typeof repository !== 'string' || typeof branch !== 'string' || !branch) {
                throw new Error(`Upstream source ${source.id} needs repository and branch fields in ${source.pinFile}`);
            }
            if (typeof current !== 'string' || !COMMIT_PATTERN.test(current)) {
                throw new Error(`Upstream source ${source.id} has no valid ${source.pinField} in ${source.pinFile}`);
            }

            const latest = await lookupRef(repository, branch);
            if (typeof latest !== 'string' || !COMMIT_PATTERN.test(latest)) {
                throw new Error(`Upstream source ${source.id} returned an invalid commit for ${branch}`);
            }
            return {
                id: source.id,
                name: source.name,
                pinFile: source.pinFile,
                pinField: source.pinField,
                repository,
                branch,
                current,
                latest,
                needsUpdate: current !== latest,
                compareUrl: compareUrl(repository, current, latest),
                labels: source.labels,
                validation: source.validation,
            };
        }),
    );
}

/** Updates only the configured pin field, retaining source metadata such as repository and branch. */
export function applyUpstreamPin({ workspaceRoot = process.cwd(), catalogPath = DEFAULT_CATALOG, id, commit }) {
    if (!COMMIT_PATTERN.test(commit ?? '')) throw new Error(`Invalid upstream commit: ${commit}`);
    const source = readCatalog(workspaceRoot, catalogPath).find(({ id: sourceId }) => sourceId === id);
    if (!source) throw new Error(`Unknown upstream pin source: ${id}`);

    const pinPath = path.join(workspaceRoot, source.pinFile);
    const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
    if (!(source.pinField in pin)) throw new Error(`Missing ${source.pinField} in ${source.pinFile}`);
    pin[source.pinField] = commit;
    fs.writeFileSync(pinPath, `${JSON.stringify(pin, null, 4)}\n`);
    return pin;
}

/** Reconciles GitHub's update PR and review issue for one upstream pin. */
export function reconcileUpstreamPin(
    input,
    {
        run = runCommand,
        writeFile = fs.writeFileSync,
        workspaceRoot = input.workspaceRoot ?? process.cwd(),
        runnerTemp = input.runnerTemp ?? process.env.RUNNER_TEMP ?? tmpdir(),
    } = {},
) {
    validateReconciliationInput(input);

    const marker = `<!-- upstream-pin:${input.sourceId} -->`;
    const branch = `automation/update-upstream-${input.sourceId}`;
    const prTitle = `${input.sourceName}: update upstream pin`;
    const issueTitle = `${input.sourceName}: upstream pin needs manual review`;
    const prBodyFile = path.join(runnerTemp, `upstream-pin-${input.sourceId}.md`);
    const issueBodyFile = path.join(runnerTemp, `upstream-pin-${input.sourceId}-issue.md`);
    const labelArgs = input.labels.flatMap((label) => ['--label', label]);
    const addLabelArgs = input.labels.flatMap((label) => ['--add-label', label]);

    // GitHub refuses to reopen a PR whose branch was deleted and pushed again, so only an open PR is reused.
    const [pullRequest] = parseJsonArray(
        run('gh', ['pr', 'list', '--state', 'open', '--head', branch, '--json', 'number']),
    );
    const issue = parseJsonArray(
        run('gh', [
            'issue',
            'list',
            '--state',
            'all',
            '--search',
            `in:body "upstream-pin:${input.sourceId}"`,
            '--json',
            'number,body,state',
        ]),
    ).find(({ body }) => (body ?? '').includes(marker));

    const closePullRequest = () => {
        if (pullRequest) run('gh', ['pr', 'close', String(pullRequest.number)]);
    };
    const closeIssue = () => {
        if (issue && issue.state === 'OPEN') run('gh', ['issue', 'close', String(issue.number)]);
    };
    const deleteBranch = () => {
        const ref = `refs/heads/${branch}`;
        if (run('git', ['ls-remote', '--heads', 'origin', ref]).trim()) {
            run('git', ['push', 'origin', '--delete', branch]);
        }
    };
    const reopenIssueIfNeeded = () => {
        if (issue && issue.state !== 'OPEN') run('gh', ['issue', 'reopen', String(issue.number)]);
    };

    if (!input.needsUpdate) {
        closePullRequest();
        closeIssue();
        deleteBranch();
        return { outcome: 'current' };
    }

    if (input.validationResult !== 'success') {
        closePullRequest();
        deleteBranch();
        writeFile(
            issueBodyFile,
            [
                marker,
                `Automatic validation failed for ${input.sourceName} at ${input.latestCommit}.`,
                '',
                `Compare: ${input.compareUrl}`,
                `Workflow run: ${input.githubRunUrl}`,
                '',
            ].join('\n'),
        );
        if (issue) {
            run('gh', [
                'issue',
                'edit',
                String(issue.number),
                '--title',
                issueTitle,
                '--body-file',
                issueBodyFile,
                ...addLabelArgs,
            ]);
            reopenIssueIfNeeded();
        } else {
            run('gh', ['issue', 'create', '--title', issueTitle, '--body-file', issueBodyFile, ...labelArgs]);
        }
        return { outcome: 'manual-review' };
    }

    closeIssue();
    run('git', ['fetch', 'origin', input.baseBranch], { cwd: workspaceRoot });
    run('git', ['checkout', '-B', branch, 'FETCH_HEAD'], { cwd: workspaceRoot });
    run('node', ['scripts/upstream-pins.mjs', 'apply', input.sourceId, input.latestCommit], { cwd: workspaceRoot });
    run('git', ['config', 'user.name', 'github-actions[bot]'], { cwd: workspaceRoot });
    run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], {
        cwd: workspaceRoot,
    });
    run('git', ['add', '--', input.pinFile], { cwd: workspaceRoot });
    if (!run('git', ['diff', '--cached', '--name-only'], { cwd: workspaceRoot }).trim()) {
        closePullRequest();
        deleteBranch();
        return { outcome: 'unchanged' };
    }

    run('git', ['commit', '-m', `chore(deps): update ${input.sourceName} pin`], { cwd: workspaceRoot });
    const ref = `refs/heads/${branch}`;
    const remoteSha = run('git', ['ls-remote', '--heads', 'origin', ref]).trim().split(/\s+/)[0] ?? '';
    const lease = `--force-with-lease=${ref}:${remoteSha}`;
    run('git', ['push', lease, 'origin', branch], { cwd: workspaceRoot });

    writeFile(
        prBodyFile,
        [
            marker,
            `Update ${input.sourceName} from ${input.currentCommit} to ${input.latestCommit}.`,
            '',
            `Compare: ${input.compareUrl}`,
            `Validation passed in the [upstream pin workflow](${input.githubRunUrl}).`,
            '',
        ].join('\n'),
    );
    if (pullRequest) {
        run('gh', [
            'pr',
            'edit',
            String(pullRequest.number),
            '--title',
            prTitle,
            '--body-file',
            prBodyFile,
            ...addLabelArgs,
        ]);
    } else {
        run('gh', [
            'pr',
            'create',
            '--title',
            prTitle,
            '--body-file',
            prBodyFile,
            '--head',
            branch,
            '--base',
            input.baseBranch,
            ...labelArgs,
        ]);
    }
    return { outcome: 'pull-request' };
}

/** Converts the matrix job's environment into the typed reconciliation input. */
export function reconciliationInputFromEnvironment(env = process.env) {
    return {
        sourceId: env.SOURCE_ID,
        sourceName: env.SOURCE_NAME,
        pinFile: env.PIN_FILE,
        currentCommit: env.CURRENT_COMMIT,
        latestCommit: env.LATEST_COMMIT,
        needsUpdate: env.NEEDS_UPDATE === 'true',
        compareUrl: env.COMPARE_URL,
        labels: JSON.parse(env.LABELS_JSON ?? '[]'),
        validationResult: env.VALIDATION_RESULT,
        baseBranch: env.BASE_BRANCH,
        githubRunUrl: env.GITHUB_RUN_URL,
        runnerTemp: env.RUNNER_TEMP,
    };
}

function validateReconciliationInput(input) {
    if (
        typeof input.sourceId !== 'string' ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.sourceId) ||
        typeof input.sourceName !== 'string' ||
        !input.sourceName ||
        typeof input.pinFile !== 'string' ||
        !input.pinFile ||
        typeof input.currentCommit !== 'string' ||
        !COMMIT_PATTERN.test(input.currentCommit) ||
        typeof input.latestCommit !== 'string' ||
        !COMMIT_PATTERN.test(input.latestCommit) ||
        typeof input.needsUpdate !== 'boolean' ||
        typeof input.compareUrl !== 'string' ||
        typeof input.baseBranch !== 'string' ||
        !input.baseBranch ||
        typeof input.githubRunUrl !== 'string' ||
        !Array.isArray(input.labels) ||
        !input.labels.every((label) => typeof label === 'string')
    ) {
        throw new Error('Invalid upstream pin reconciliation input');
    }
}

function parseJsonArray(output) {
    const result = JSON.parse(output);
    if (!Array.isArray(result)) throw new Error('GitHub CLI response must be an array');
    return result;
}

function runCommand(program, args, { cwd = process.cwd() } = {}) {
    return execFileSync(program, args, {
        cwd,
        encoding: 'utf8',
        stdio: ['inherit', 'pipe', 'inherit'],
    });
}

function readCatalog(workspaceRoot, catalogPath) {
    const catalog = JSON.parse(fs.readFileSync(path.resolve(workspaceRoot, catalogPath), 'utf8'));
    if (!Array.isArray(catalog.sources)) throw new Error('Upstream pin catalog must contain a sources array');
    const ids = new Set();
    for (const source of catalog.sources) {
        if (
            typeof source.id !== 'string' ||
            !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(source.id) ||
            ids.has(source.id) ||
            typeof source.name !== 'string' ||
            typeof source.pinFile !== 'string' ||
            typeof source.pinField !== 'string' ||
            !Array.isArray(source.labels) ||
            !source.labels.every((label) => typeof label === 'string') ||
            !Array.isArray(source.validation) ||
            !source.validation.length ||
            !source.validation.every((argument) => typeof argument === 'string')
        ) {
            throw new Error(`Invalid or duplicate upstream pin source: ${source.id ?? '<unnamed>'}`);
        }
        ids.add(source.id);
    }
    return catalog.sources;
}

function lookupGitRef(repository, branch) {
    const result = execFileSync('git', ['ls-remote', '--exit-code', repository, `refs/heads/${branch}`], {
        encoding: 'utf8',
    });
    return result.trim().split(/\s+/)[0];
}

function compareUrl(repository, current, latest) {
    const url = new URL(repository);
    if (url.hostname !== 'github.com') throw new Error(`Compare links are not configured for ${repository}`);
    const slug = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    return `https://github.com/${slug}/compare/${current}...${latest}`;
}

function runValidation({ workspaceRoot, catalogPath, id }) {
    const source = readCatalog(workspaceRoot, catalogPath).find(({ id: sourceId }) => sourceId === id);
    if (!source) throw new Error(`Unknown upstream pin source: ${id}`);
    execFileSync(source.validation[0], source.validation.slice(1), {
        cwd: workspaceRoot,
        stdio: 'inherit',
    });
}

async function main() {
    const workspaceRoot = process.cwd();
    const catalogPath = process.env.UPSTREAM_PIN_CATALOG ?? DEFAULT_CATALOG;
    const program = new Command()
        .name('upstream-pins')
        .description('Discover, apply, validate, or reconcile configured upstream pins.');
    program
        .command('discover')
        .description('Discover the latest commit for each configured upstream pin.')
        .action(async () => {
            const include = await discoverUpstreamPins({ workspaceRoot, catalogPath });
            process.stdout.write(`${JSON.stringify({ include })}\n`);
        });
    program
        .command('apply')
        .description('Update one upstream pin to a commit.')
        .argument('<id>', 'Upstream pin source id')
        .argument('<commit>', 'Commit SHA to apply')
        .action((id, commit) => applyUpstreamPin({ workspaceRoot, catalogPath, id, commit }));
    program
        .command('validate')
        .description('Run the configured validation command for one upstream pin.')
        .argument('<id>', 'Upstream pin source id')
        .action((id) => runValidation({ workspaceRoot, catalogPath, id }));
    program
        .command('reconcile')
        .description('Reconcile the configured pin with its update pull request or review issue.')
        .action(() => reconcileUpstreamPin(reconciliationInputFromEnvironment(), { workspaceRoot }));
    await program.parseAsync(process.argv);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
