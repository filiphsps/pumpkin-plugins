import { readFileSync } from 'node:fs';
import { discoverComponents } from '@pumpkin-plugins/docs/node';
import { ignoredCommitShas } from './ignored-commits.mjs';
import { PUBLIC_TOOL_PACKAGE_PATHS } from './tool-packages.mjs';

/** Reads workspace package manifests for identifying code bundled into each plugin. */
export function workspacePackages(root) {
    const packages = new Map();
    for (const group of ['packages', 'tools', 'extensions']) {
        for (const { slug, metadataFile } of discoverComponents(root, group)) {
            const path = `${group}/${slug}`;
            const manifest = JSON.parse(readFileSync(metadataFile, 'utf8'));
            packages.set(manifest.name, { path, manifest });
        }
    }
    return packages;
}

/** Finds a plugin's transitive runtime packages and its build tool, excluding test-only dependencies. */
export function bundledPaths(packages, pluginPath) {
    const paths = new Set();
    const visit = (pkg) => {
        if (!pkg || paths.has(pkg.path)) return;
        paths.add(pkg.path);
        for (const name of Object.keys(pkg.manifest.dependencies ?? {})) visit(packages.get(name));
        for (const name of pkg.manifest.pumpkinBundleDependencies ?? []) visit(packages.get(name));
        // The build tool changes shipped WASM, while other dev dependencies only run checks.
        if (pkg.manifest.devDependencies?.['@pumpkin-plugins/build']) visit(packages.get('@pumpkin-plugins/build'));
    };
    visit([...packages.values()].find((pkg) => pkg.path === pluginPath));
    if (!paths.has(pluginPath)) throw new Error(`Unknown release package: ${pluginPath}`);
    return paths;
}

function shippedFile(file, paths) {
    if (
        /\.md$|(?:^|\/)(?:test|testing|__tests__)\/|^(?:packages|tools|extensions)\/[^/]+\/(?:build|dist|node_modules)\/|\.(?:spec|test|itest)\.[cm]?[jt]s$/.test(
            file,
        )
    )
        return false;
    if (file === 'pnpm-workspace.yaml' || file === 'tsconfig.base.json') return true;
    return [...paths].some((path) => file.startsWith(`${path}/`));
}

function hasReleaseAs(commit) {
    return /(?:^|\n)Release-As:\s*\S+/.test(commit.message ?? '');
}

function releaseAsTargetsComponent(commit, component) {
    if (!hasReleaseAs(commit)) return true;
    const scope = /^[\w-]+(?:\(([^)]+)\))?!?:/.exec(commit.message ?? '')?.[1];
    return scope === component;
}

/** Selects relevant commits in newest-first order, stopping at this plugin's own previous release. */
export function releaseCommits(commits, paths, lastReleaseSha, component) {
    const boundary = lastReleaseSha ? commits.findIndex((commit) => commit.sha === lastReleaseSha) : commits.length;
    if (boundary === -1) throw new Error(`Release commit ${lastReleaseSha} is missing from the fetched history`);
    const seen = new Set();
    return commits.slice(0, boundary).filter((commit) => {
        if (ignoredCommitShas.has(commit.sha)) return false;
        if (!Array.isArray(commit.files)) throw new Error(`Commit ${commit.sha} has no changed-file list`);
        if (seen.has(commit.sha)) return false;
        seen.add(commit.sha);
        if (commit.files.length === 0) return hasReleaseAs(commit) && releaseAsTargetsComponent(commit, component);
        return releaseAsTargetsComponent(commit, component) && commit.files.some((file) => shippedFile(file, paths));
    });
}

function commitShasSinceRelease(commits, lastReleaseSha) {
    const boundary = commits.findIndex((commit) => commit.sha === lastReleaseSha);
    if (boundary === -1) throw new Error(`Release commit ${lastReleaseSha} is missing from the fetched history`);
    return new Set(
        commits
            .slice(0, boundary)
            .filter((commit) => !ignoredCommitShas.has(commit.sha))
            .map((commit) => commit.sha),
    );
}

async function previousPublishedRelease(github, currentTag) {
    if (
        !currentTag ||
        typeof currentTag.constructor.parse !== 'function' ||
        typeof github.releaseIterator !== 'function'
    )
        return undefined;
    let previousRelease;
    for await (const release of github.releaseIterator()) {
        let tag;
        try {
            tag = currentTag.constructor.parse(release.tagName);
        } catch {
            continue;
        }
        if (!tag || tag.component !== currentTag.component || tag.version.compare(currentTag.version) >= 0) continue;
        if (!previousRelease || tag.version.compare(previousRelease.tag.version) > 0) {
            previousRelease = { ...release, tag };
        }
    }
    return previousRelease;
}

async function firstPackageCommitSha(github, branch, path) {
    const api = github.getGitHubApi?.();
    const listCommits = api?.octokit?.rest?.repos?.listCommits;
    if (!api?.repository?.owner || !api.repository.repo || !listCommits || !api.octokit.paginate) {
        throw new Error(`Cannot find the package introduction commit for ${path}`);
    }
    const commits = await api.octokit.paginate(listCommits, {
        owner: api.repository.owner,
        repo: api.repository.repo,
        sha: branch,
        path: `${path}/package.json`,
        per_page: 100,
    });
    const firstCommit = commits.at(-1);
    if (!firstCommit?.sha) throw new Error(`Cannot find the package introduction commit for ${path}`);
    return firstCommit.sha;
}

/** Adds bundled dependency commits before Release Please computes versions, PR bodies and changelogs. */
export function bundledChangesPlugin(github, branch, packages, releasedVersions, maxCommits = 500) {
    return {
        async preconfigure(strategies, commitsByPath, releasesByPath) {
            const actionPaths = Object.keys(strategies).filter((path) => path.startsWith('actions/'));
            for (const path of actionPaths) {
                const component = path.split('/').at(-1);
                commitsByPath[path] = (commitsByPath[path] ?? []).filter(
                    (commit) => !ignoredCommitShas.has(commit.sha) && releaseAsTargetsComponent(commit, component),
                );
            }
            const pluginPaths = Object.keys(strategies).filter((path) => path.startsWith('packages/'));
            const toolPaths = Object.keys(strategies).filter((path) => Object.hasOwn(PUBLIC_TOOL_PACKAGE_PATHS, path));
            const extensionPaths = Object.keys(strategies).filter((path) => path.startsWith('extensions/'));
            const packagePaths = [...pluginPaths, ...toolPaths, ...extensionPaths];
            const releasePaths = [...packagePaths, ...actionPaths];
            if (releasePaths.length === 0) return strategies;
            const commits = [];
            const boundaries = new Set();
            for (const path of releasePaths) {
                const release = releasesByPath[path];
                if (release?.sha) boundaries.add(release.sha);
                else if (releasedVersions[path]?.toString() === '0.0.0') {
                    if (packagePaths.includes(path)) boundaries.add(await firstPackageCommitSha(github, branch, path));
                } else {
                    const previousRelease = await previousPublishedRelease(github, release?.tag);
                    if (!previousRelease?.sha) {
                        throw new Error(
                            `Cannot find a published release before ${release?.tag ?? releasedVersions[path]} for ${path}`,
                        );
                    }
                    releasesByPath[path] = previousRelease;
                    boundaries.add(previousRelease.sha);
                }
            }
            // Fetch unfiltered history for plugin dependency commits and action release boundaries.
            for await (const commit of github.mergeCommitIterator(branch, {
                backfillFiles: true,
                maxResults: maxCommits + 1,
            })) {
                if (commits.length === maxCommits)
                    throw new Error(`Release history exceeds ${maxCommits} commits; increase commit-search-depth`);
                commits.push(commit);
                boundaries.delete(commit.sha);
                if (boundaries.size === 0) break;
            }
            for (const path of packagePaths) {
                commitsByPath[path] = releaseCommits(
                    commits,
                    bundledPaths(packages, path),
                    releasesByPath[path]?.sha,
                    path.split('/').at(-1),
                );
            }
            for (const path of actionPaths) {
                const lastReleaseSha = releasesByPath[path]?.sha;
                if (!lastReleaseSha) continue;
                const includedShas = commitShasSinceRelease(commits, lastReleaseSha);
                commitsByPath[path] = (commitsByPath[path] ?? []).filter((commit) => includedShas.has(commit.sha));
            }
            return strategies;
        },
        processCommits: (commits) => commits,
        run: async (candidates) => candidates,
    };
}
