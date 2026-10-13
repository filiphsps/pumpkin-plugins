// Run with the pinned release-please runtime supplied by pnpm dlx. --dry-run makes no GitHub writes.

import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundledChangesPlugin, workspacePackages } from './release-commits.mjs';
import { partitionReleasePaths } from './release-fanout.mjs';

const args = process.argv.slice(2);
if (
    args.some(
        (arg) =>
            arg.startsWith('--') &&
            arg !== '--dry-run' &&
            arg !== '--pull-requests-only' &&
            !/^--component=.+$/.test(arg)
    )
) {
    throw new Error('Supported options: --dry-run, --pull-requests-only, --component=<name>');
}
const cliPath = args.find((arg) => !arg.startsWith('--'));
if (!cliPath) throw new Error('Pass the release-please executable path from pnpm dlx');
const requireRuntime = createRequire(resolve(cliPath));
const { GitHub, Manifest, VERSION } = requireRuntime('release-please');
if (VERSION !== '17.11.2') throw new Error(`Expected release-please 17.11.2, received ${VERSION}`);
const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
if (!owner || !repo || !process.env.GITHUB_TOKEN) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
const github = await GitHub.create({ owner, repo, token: process.env.GITHUB_TOKEN });
const branch = github.repository.defaultBranch;
const packages = workspacePackages(resolve(import.meta.dirname, '..'));
if (
    args.some((arg) => arg.startsWith('--component=')) &&
    !args.includes('--dry-run') &&
    !args.includes('--pull-requests-only')
) {
    throw new Error('--component requires --dry-run or --pull-requests-only');
}
const load = async () => {
    const manifest = await Manifest.fromManifest(
        github,
        branch,
        'release-please-config.json',
        '.release-please-manifest.json'
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
    release_count: '0',
    prs: '[]',
    pr_count: '0'
};

function isImmutableReleaseConflict(error) {
    return (
        error?.status === 422 &&
        Array.isArray(error.body?.errors) &&
        error.body.errors.some(
            (problem) =>
                problem.field === 'tag_name' && problem.message?.includes('tag_name was used by an immutable release')
        )
    );
}

if (!args.includes('--dry-run') && !args.includes('--pull-requests-only')) {
    const manifest = await load();
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
                        `GitHub release ${tagName} points to ${release.sha}, but Release Please expects ${candidate.sha}`
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
                    recovered: true
                });
            }

            if (pullRequest?.number && !manifest.skipLabeling) {
                await github.removeIssueLabels(manifest.labels, pullRequest.number);
                await github.addIssueLabels(manifest.releaseLabels, pullRequest.number);
            }
            console.warn(
                `GitHub already has this release tag; reusing its metadata for the release run: ${recovered
                    .map((release) => release.tagName)
                    .join(', ')}`
            );
            return recovered;
        }
    };
    const createdReleases = (await manifest.createReleases()).filter(Boolean);
    const releases = createdReleases.filter((release) => {
        if (!release.sha) throw new Error(`Release ${release.tagName} has no target commit SHA`);
        if (release.sha === process.env.GITHUB_SHA) return true;
        console.log(
            `Deferring ${release.tagName} from artifact fan-out: tag targets ${release.sha}, but this run built ${process.env.GITHUB_SHA}`
        );
        return false;
    });
    const releasePaths = partitionReleasePaths(releases);
    outputs.paths_released = JSON.stringify(releasePaths.pluginPaths);
    outputs.action_paths_released = JSON.stringify(releasePaths.actionPaths);
    outputs.tool_paths_released = JSON.stringify(releasePaths.toolPaths);
    outputs.release_count = String(releases.length);
    for (const release of releases) {
        outputs[`${release.path}--release_created`] = !release.recovered;
        if (release.recovered) outputs[`${release.path}--release_recovered`] = true;
        for (const [name, value] of Object.entries(release)) {
            const key = { tagName: 'tag_name', uploadUrl: 'upload_url', notes: 'body', url: 'html_url' }[name] ?? name;
            outputs[`${release.path}--${key}`] = value;
        }
    }
}
const manifest = await load();
manifest.plugins.push(
    bundledChangesPlugin(github, branch, packages, manifest.releasedVersions, manifest.commitSearchDepth)
);
const component = args.find((arg) => arg.startsWith('--component='))?.slice('--component='.length);
if (component) {
    manifest.plugins.push({
        preconfigure: async (strategies) => strategies,
        processCommits: (commits) => commits,
        run: async (candidates) => candidates.filter((candidate) => candidate.config.component === component)
    });
}
if (args.includes('--dry-run')) {
    const candidates = await manifest.buildPullRequests();
    console.log(
        JSON.stringify(
            candidates.map((pr) => ({
                title: pr.title.toString(),
                body: pr.body.toString(),
                branch: pr.headRefName.toString()
            })),
            null,
            4
        )
    );
} else {
    const prs = (await manifest.createPullRequests()).filter(Boolean);
    outputs.prs = JSON.stringify(prs);
    outputs.pr_count = String(prs.length);
    if (process.env.GITHUB_OUTPUT) {
        for (const [name, value] of Object.entries(outputs)) {
            const marker = `release_${randomUUID()}`;
            appendFileSync(
                process.env.GITHUB_OUTPUT,
                `${name}<<${marker}\n${typeof value === 'string' ? value : JSON.stringify(value)}\n${marker}\n`
            );
        }
    }
    console.log(`Prepared ${prs.length} release PR(s)`);
    console.log(
        `Release fan-out: plugin paths=${outputs.paths_released}, action paths=${outputs.action_paths_released}, tool paths=${outputs.tool_paths_released}, release PR count=${prs.length}`
    );
}
