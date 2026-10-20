// Run with the pinned release-please runtime supplied by pnpm dlx. --dry-run makes no GitHub writes.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { installCommitFilesCache } from './utils/commit-files-cache.mjs';
import { bundledChangesPlugin, workspacePackages } from './utils/release-commits.mjs';
import { collectReleaseFanout, releaseOutputs } from './utils/release-fanout.mjs';
import { recoverImmutableReleaseConflict } from './utils/release-recovery.mjs';
import { resolveReleaseTargetSha } from './utils/release-target.mjs';
import { enableLegacyReleaseTitleParsing } from './utils/release-title-compat.mjs';

const program = new Command()
    .name('release')
    .description('Create release PRs with the pinned release-please runtime.')
    .argument('<release-please-cli>', 'Path to the release-please executable supplied by pnpm dlx')
    .option('--dry-run', 'Preview release PRs without publishing or writing workflow outputs')
    .option('--pull-requests-only', 'Create or update release PRs without publishing releases')
    .option('--component <name>', 'Limit a dry-run or PR-only run to one component')
    .parse(process.argv);
const [cliPath] = program.args;
const { dryRun, pullRequestsOnly, component } = program.opts();
const toolOnly = process.env.RELEASE_TOOL_ONLY === 'true';
if (process.env.RELEASE_TOOL_ONLY && !['true', 'false'].includes(process.env.RELEASE_TOOL_ONLY)) {
    throw new Error('RELEASE_TOOL_ONLY must be true or false');
}
if (component && !dryRun && !pullRequestsOnly)
    throw new Error('--component requires --dry-run or --pull-requests-only');
const requireRuntime = createRequire(resolve(cliPath));
const { GitHub, Manifest, VERSION } = requireRuntime('release-please');
if (VERSION !== '17.11.2') throw new Error(`Expected release-please 17.11.2, received ${VERSION}`);
const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
if (!owner || !repo || !process.env.GITHUB_TOKEN) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
const github = await GitHub.create({ owner, repo, token: process.env.GITHUB_TOKEN });
const commitFilesCache = process.env.RELEASE_COMMIT_FILES_CACHE
    ? installCommitFilesCache(github, process.env.RELEASE_COMMIT_FILES_CACHE)
    : undefined;
const branch = github.repository.defaultBranch;
const repositoryRoot = resolve(import.meta.dirname, '..');
const packages = workspacePackages(repositoryRoot);
const load = () => Manifest.fromManifest(github, branch, 'release-please-config.json', '.release-please-manifest.json');
const outputs = {
    paths_released: '[]',
    action_paths_released: '[]',
    tool_paths_released: '[]',
    extension_paths_released: '[]',
    release_metadata: '{}',
    release_count: '0',
    prs: '[]',
    pr_count: '0',
};

function normalizeImmutableReleaseCandidates(candidates) {
    if (!Array.isArray(candidates)) return candidates;
    return candidates.map((candidate) => {
        const { tag } = candidate;
        const version = tag.version;
        return {
            tagName: tag.toString(),
            sha: candidate.sha,
            path: candidate.path,
            version: version.toString(),
            major: version.major,
            minor: version.minor,
            patch: version.patch,
        };
    });
}

if (!dryRun && !pullRequestsOnly) {
    const manifest = await load();
    enableLegacyReleaseTitleParsing(manifest);
    const currentSha = resolveReleaseTargetSha({
        eventName: process.env.GITHUB_EVENT_NAME,
        workflowSha: process.env.GITHUB_SHA,
        requestedSha: process.env.RELEASE_TARGET_SHA,
        toolOnly,
    });
    const createReleasesForPullRequest = manifest.createReleasesForPullRequest.bind(manifest);
    let existingReleasesByTag;
    async function getExistingReleases() {
        if (!existingReleasesByTag) {
            existingReleasesByTag = new Map();
            for await (const release of github.releaseIterator()) {
                existingReleasesByTag.set(release.tagName, release);
            }
        }
        return [...existingReleasesByTag.values()];
    }
    async function existingRelease(tagName) {
        await getExistingReleases();
        return existingReleasesByTag.get(tagName);
    }
    async function getReleaseAssets(tagName) {
        const { data } = await github.getGitHubApi().octokit.repos.getReleaseByTag({ owner, repo, tag: tagName });
        return { assets: data.assets.map(({ name }) => name), immutable: data.immutable };
    }

    manifest.createReleasesForPullRequest = async (...releaseArgs) => {
        try {
            return await createReleasesForPullRequest(...releaseArgs);
        } catch (error) {
            const pullRequest = releaseArgs[1];
            const recovered = await recoverImmutableReleaseConflict({
                error,
                getCandidates: () => normalizeImmutableReleaseCandidates(releaseArgs[0]),
                pullRequestNumber: pullRequest?.number,
                labelingEnabled: !manifest.skipLabeling,
                findRelease: existingRelease,
                restoreLabels: async (pullRequestNumber) => {
                    await github.removeIssueLabels(manifest.labels, pullRequestNumber);
                    await github.addIssueLabels(manifest.releaseLabels, pullRequestNumber);
                },
            });
            console.warn(
                `GitHub already has this release tag; reusing its metadata for the release run: ${recovered
                    .map((release) => release.tagName)
                    .join(', ')}`,
            );
            return recovered;
        }
    };
    const createdReleases = toolOnly ? [] : (await manifest.createReleases()).filter(Boolean);
    const firstParentShas = toolOnly
        ? new Set([currentSha])
        : new Set(
              execFileSync('git', ['rev-list', '--first-parent', currentSha], {
                  cwd: repositoryRoot,
                  encoding: 'utf8',
              })
                  .split(/\r?\n/)
                  .filter(Boolean),
          );
    const { releases, paths: releasePaths } = await collectReleaseFanout({
        createdReleases,
        repositoryConfig: manifest.repositoryConfig,
        releasedVersions: manifest.releasedVersions,
        currentSha,
        findRelease: existingRelease,
        existingReleases: toolOnly ? [] : await getExistingReleases(),
        firstParentShas,
        getReleaseAssets,
        root: repositoryRoot,
        toolOnly,
    });
    Object.assign(outputs, releaseOutputs(releases, releasePaths));
}
const manifest = await load();
manifest.plugins.push(
    bundledChangesPlugin(
        github,
        branch,
        packages,
        manifest.releasedVersions,
        manifest.commitSearchDepth,
        console.error,
        repositoryRoot,
    ),
);
if (component) {
    manifest.plugins.push({
        preconfigure: async (strategies) => strategies,
        processCommits: (commits) => commits,
        run: async (candidates) => candidates.filter((candidate) => candidate.config.component === component),
    });
}
if (dryRun) {
    const candidates = await manifest.buildPullRequests();
    console.log(
        JSON.stringify(
            candidates.map((pr) => ({
                title: pr.title.toString(),
                body: pr.body.toString(),
                branch: pr.headRefName.toString(),
            })),
            null,
            4,
        ),
    );
} else {
    const prs = toolOnly ? [] : (await manifest.createPullRequests()).filter(Boolean);
    outputs.prs = JSON.stringify(prs);
    outputs.pr_count = String(prs.length);
    if (process.env.GITHUB_OUTPUT) {
        for (const [name, value] of Object.entries(outputs)) {
            const marker = `release_${randomUUID()}`;
            appendFileSync(
                process.env.GITHUB_OUTPUT,
                `${name}<<${marker}\n${typeof value === 'string' ? value : JSON.stringify(value)}\n${marker}\n`,
            );
        }
    }
    console.log(`Prepared ${prs.length} release PR(s)`);
    console.log(
        `Release fan-out: plugin paths=${outputs.paths_released}, action paths=${outputs.action_paths_released}, tool paths=${outputs.tool_paths_released}, extension paths=${outputs.extension_paths_released}, release PR count=${prs.length}`,
    );
}
commitFilesCache?.save();
