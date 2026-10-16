import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { discoverComponents } from '@pumpkin-plugins/docs/node';
import { ignoredCommitShas } from './ignored-commits.mjs';
import { sourcePrerequisitePaths } from './tool-packages.mjs';

const DEFAULT_WORKSPACE_ROOT = resolve(import.meta.dirname, '../..');

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

/** Finds workspace paths whose source is shipped with a release package. */
export function bundledPaths(packages, releasePath) {
    const paths = new Set();
    const isPublicTool = releasePath.startsWith('tools/');
    const visit = (pkg) => {
        if (!pkg || paths.has(pkg.path)) return;
        paths.add(pkg.path);
        if (!isPublicTool) {
            for (const name of Object.keys(pkg.manifest.dependencies ?? {})) visit(packages.get(name));
            for (const name of pkg.manifest.pumpkinBundleDependencies ?? []) visit(packages.get(name));
        }
        // Only a plugin's own build tool affects its WASM; npm tools release dependencies separately.
        if (
            pkg.path === releasePath &&
            releasePath.startsWith('packages/') &&
            pkg.manifest.devDependencies?.['@pumpkin-plugins/build']
        ) {
            visit(packages.get('@pumpkin-plugins/build'));
        }
    };
    visit([...packages.values()].find((pkg) => pkg.path === releasePath));
    if (!paths.has(releasePath)) throw new Error(`Unknown release package: ${releasePath}`);
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

/** Adds bundled dependency commits and defers tools until their public dependencies have released.
 *
 * @param {number} [maxCommits=500] - Maximum release-history commits to inspect.
 * @param {(message: string) => void} [log=console.error] - Receives deferred-candidate messages.
 * @param {string} [root=DEFAULT_WORKSPACE_ROOT] - Workspace root for reading package and template dependencies.
 */
export function bundledChangesPlugin(
    github,
    branch,
    packages,
    releasedVersions,
    maxCommits = 500,
    log = console.error,
    root = DEFAULT_WORKSPACE_ROOT,
) {
    const publicToolDependencies = new Map();
    for (const pkg of packages.values()) {
        if (
            pkg.path.startsWith('tools/') &&
            pkg.manifest.private !== true &&
            pkg.manifest.publishConfig?.access === 'public'
        ) {
            publicToolDependencies.set(pkg.path, new Set());
        }
    }
    const pathsByName = new Map([...packages].map(([name, pkg]) => [name, pkg.path]));
    for (const pkg of packages.values()) {
        if (!publicToolDependencies.has(pkg.path)) continue;
        const prerequisites = sourcePrerequisitePaths(root, pkg.path, pathsByName);
        for (const dependencyPath of prerequisites) {
            if (publicToolDependencies.has(dependencyPath)) publicToolDependencies.get(pkg.path).add(dependencyPath);
        }
    }

    function unreleasedDependencies(packagePath) {
        const unreleased = [];
        const visited = new Set();
        const visit = (currentPath) => {
            for (const dependencyPath of publicToolDependencies.get(currentPath) ?? []) {
                if (visited.has(dependencyPath)) continue;
                visited.add(dependencyPath);
                const version = releasedVersions[dependencyPath]?.toString();
                if (!version || version === '0.0.0') unreleased.push(dependencyPath);
                else visit(dependencyPath);
            }
        };
        visit(packagePath);
        return unreleased;
    }

    return {
        async preconfigure(strategies, commitsByPath, releasesByPath) {
            const publicToolPaths = new Set(publicToolDependencies.keys());
            const actionPaths = Object.keys(strategies).filter((path) => path.startsWith('actions/'));
            for (const path of actionPaths) {
                const component = path.split('/').at(-1);
                commitsByPath[path] = (commitsByPath[path] ?? []).filter(
                    (commit) => !ignoredCommitShas.has(commit.sha) && releaseAsTargetsComponent(commit, component),
                );
            }
            const pluginPaths = Object.keys(strategies).filter((path) => path.startsWith('packages/'));
            const toolPaths = Object.keys(strategies).filter((path) => publicToolPaths.has(path));
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
                    if (previousRelease?.sha) {
                        releasesByPath[path] = previousRelease;
                        boundaries.add(previousRelease.sha);
                    } else if (packagePaths.includes(path)) {
                        const introductionSha = await firstPackageCommitSha(github, branch, path);
                        releasesByPath[path] = { ...release, sha: introductionSha };
                        boundaries.add(introductionSha);
                    } else {
                        throw new Error(
                            `Cannot find a published release before ${release?.tag ?? releasedVersions[path]} for ${path}`,
                        );
                    }
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
        run: async (candidates) =>
            candidates.filter((candidate) => {
                if (!publicToolDependencies.has(candidate.path)) return true;
                const unreleased = unreleasedDependencies(candidate.path);
                if (unreleased.length === 0) return true;
                log(
                    `Deferring ${candidate.path} release PR until public dependencies release: ${unreleased.join(', ')}`,
                );
                return false;
            }),
    };
}
