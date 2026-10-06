import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Reads workspace package manifests for identifying code bundled into each plugin. */
export function workspacePackages(root) {
    const packages = new Map();
    for (const group of ['packages', 'tools']) {
        for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
            const path = `${group}/${entry.name}`;
            const manifestPath = join(root, path, 'package.json');
            if (!existsSync(manifestPath)) continue;
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
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
        // The build tool changes shipped WASM, while other dev dependencies only run checks.
        if (pkg.manifest.devDependencies?.['@pumpkin-plugins/build']) visit(packages.get('@pumpkin-plugins/build'));
    };
    visit([...packages.values()].find((pkg) => pkg.path === pluginPath));
    if (!paths.has(pluginPath)) throw new Error(`Unknown release package: ${pluginPath}`);
    return paths;
}

function shippedFile(file, paths) {
    if (
        /\.md$|(?:^|\/)(?:test|testing|__tests__)\/|^(?:packages|tools)\/[^/]+\/(?:build|dist|node_modules)\/|\.(?:test|itest)\.[cm]?[jt]s$/.test(
            file
        )
    )
        return false;
    if (file === 'pnpm-workspace.yaml' || file === 'tsconfig.base.json') return true;
    return [...paths].some((path) => file.startsWith(`${path}/`));
}

/** Selects relevant commits in newest-first order, stopping at this plugin's own previous release. */
export function releaseCommits(commits, paths, lastReleaseSha) {
    const boundary = lastReleaseSha ? commits.findIndex((commit) => commit.sha === lastReleaseSha) : commits.length;
    if (boundary === -1) throw new Error(`Release commit ${lastReleaseSha} is missing from the fetched history`);
    const seen = new Set();
    return commits.slice(0, boundary).filter((commit) => {
        if (!Array.isArray(commit.files)) throw new Error(`Commit ${commit.sha} has no changed-file list`);
        if (seen.has(commit.sha)) return false;
        seen.add(commit.sha);
        // Preserve Release Please's support for empty Release-As commits.
        return commit.files.length === 0 || commit.files.some((file) => shippedFile(file, paths));
    });
}

/** Adds bundled dependency commits before Release Please computes versions, PR bodies and changelogs. */
export function bundledChangesPlugin(github, branch, packages, releasedVersions, maxCommits = 500) {
    return {
        async preconfigure(strategies, commitsByPath, releasesByPath) {
            const pluginPaths = Object.keys(strategies).filter((path) => path.startsWith('packages/'));
            if (pluginPaths.length === 0) return strategies;
            const commits = [];
            const boundaries = new Set();
            let initialRelease = false;
            for (const path of pluginPaths) {
                const sha = releasesByPath[path]?.sha;
                if (sha) boundaries.add(sha);
                else if (releasedVersions[path]?.toString() === '0.0.0') initialRelease = true;
                else throw new Error(`Cannot find the previous release commit for ${path}`);
            }
            // Fetch unfiltered history: normal per-plugin splitting has already discarded tool commits.
            for await (const commit of github.mergeCommitIterator(branch, {
                backfillFiles: true,
                maxResults: maxCommits + 1
            })) {
                if (commits.length === maxCommits)
                    throw new Error(`Release history exceeds ${maxCommits} commits; increase commit-search-depth`);
                commits.push(commit);
                boundaries.delete(commit.sha);
                if (!initialRelease && boundaries.size === 0) break;
            }
            for (const path of pluginPaths) {
                commitsByPath[path] = releaseCommits(commits, bundledPaths(packages, path), releasesByPath[path]?.sha);
            }
            return strategies;
        },
        processCommits: (commits) => commits,
        run: async (candidates) => candidates
    };
}
