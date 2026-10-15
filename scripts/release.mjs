// Run with the pinned release-please runtime supplied by pnpm dlx. --dry-run makes no GitHub writes.

import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { installCommitFilesCache } from './utils/commit-files-cache.mjs';
import { bundledChangesPlugin, workspacePackages } from './utils/release-commits.mjs';
import { collectReleaseFanout } from './utils/release-fanout.mjs';
import { resolveReleaseTargetSha } from './utils/release-target.mjs';

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
const load = async () => {
    const manifest = await Manifest.fromManifest(
        github,
        branch,
        'release-please-config.json',
        '.release-please-manifest.json',
    );
    for (const config of Object.values(manifest.repositoryConfig)) {
        config.bumpMinorPreMajor = true;
        config.bumpPatchForMinorPreMajor = true;
    }
    return manifest;
};
const outputs = {
    paths_released: '[]',
    action_paths_released: '[]',
    tool_paths_released: '[]',
    extension_paths_released: '[]',
    release_metadata: '{}',
    release_notes: '{}',
    release_count: '0',
    prs: '[]',
    pr_count: '0',
};

function isImmutableReleaseConflict(error) {
    return (
        error?.status === 422 &&
        Array.isArray(error.body?.errors) &&
        error.body.errors.some(
            (problem) =>
                problem.field === 'tag_name' && problem.message?.includes('tag_name was used by an immutable release'),
        )
    );
}

if (!dryRun && !pullRequestsOnly) {
    const manifest = await load();
    const currentSha = resolveReleaseTargetSha({
        eventName: process.env.GITHUB_EVENT_NAME,
        workflowSha: process.env.GITHUB_SHA,
        requestedSha: process.env.RELEASE_TARGET_SHA,
        toolOnly,
    });
    const createReleasesForPullRequest = manifest.createReleasesForPullRequest.bind(manifest);
    let existingReleasesByTag;
    async function existingRelease(tagName) {
        if (!existingReleasesByTag) {
            existingReleasesByTag = new Map();
            for await (const release of github.releaseIterator()) {
                existingReleasesByTag.set(release.tagName, release);
            }
        }
        return existingReleasesByTag.get(tagName);
    }

    manifest.createReleasesForPullRequest = async (...releaseArgs) => {
        try {
            return await createReleasesForPullRequest(...releaseArgs);
        } catch (error) {
            if (!isImmutableReleaseConflict(error)) throw error;
            const pullRequest = releaseArgs[1];
            const candidates = releaseArgs[0];
            if (!Array.isArray(candidates)) throw new Error('Could not resolve release candidates for an existing tag');

            const recovered = [];
            for (const candidate of candidates) {
                const tagName = candidate.tag.toString();
                const release = await existingRelease(tagName);
                if (!release)
                    throw new Error(`GitHub rejected ${tagName} as a duplicate, but no existing release was found`);
                if (release.sha !== candidate.sha) {
                    throw new Error(
                        `GitHub release ${tagName} points to ${release.sha}, but Release Please expects ${candidate.sha}`,
                    );
                }
                recovered.push({
                    ...release,
                    path: candidate.path,
                    version: candidate.tag.version.toString(),
                    major: candidate.tag.version.major,
                    minor: candidate.tag.version.minor,
                    patch: candidate.tag.version.patch,
                    prNumber: pullRequest?.number,
                    recovered: true,
                });
            }

            if (pullRequest?.number && !manifest.skipLabeling) {
                await github.removeIssueLabels(manifest.labels, pullRequest.number);
                await github.addIssueLabels(manifest.releaseLabels, pullRequest.number);
            }
            console.warn(
                `GitHub already has this release tag; reusing its metadata for the release run: ${recovered
                    .map((release) => release.tagName)
                    .join(', ')}`,
            );
            return recovered;
        }
    };
    const createdReleases = toolOnly ? [] : (await manifest.createReleases()).filter(Boolean);
    const { releases, paths: releasePaths } = await collectReleaseFanout({
        createdReleases,
        repositoryConfig: manifest.repositoryConfig,
        releasedVersions: manifest.releasedVersions,
        currentSha,
        findRelease: existingRelease,
        root: repositoryRoot,
        toolOnly,
    });
    outputs.paths_released = JSON.stringify(releasePaths.pluginPaths);
    outputs.action_paths_released = JSON.stringify(releasePaths.actionPaths);
    outputs.tool_paths_released = JSON.stringify(releasePaths.toolPaths);
    outputs.extension_paths_released = JSON.stringify(releasePaths.extensionPaths);
    outputs.release_count = String(releases.length);
    const releaseMetadata = {};
    const releaseNotes = {};
    for (const release of releases) {
        outputs[`${release.path}--release_created`] = !release.recovered;
        if (release.recovered) outputs[`${release.path}--release_recovered`] = true;
        for (const [name, value] of Object.entries(release)) {
            const key = { tagName: 'tag_name', uploadUrl: 'upload_url', notes: 'body', url: 'html_url' }[name] ?? name;
            outputs[`${release.path}--${key}`] = value;
            if (key === 'tag_name') releaseMetadata[`${release.path}--${key}`] = value;
            if (key === 'body') releaseNotes[`${release.path}--${key}`] = value;
        }
    }
    outputs.release_metadata = JSON.stringify(releaseMetadata);
    outputs.release_notes = JSON.stringify(releaseNotes);
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
