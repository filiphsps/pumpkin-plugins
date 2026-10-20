import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { getNpmRegistryVersions, publishToolPackages } from './publish-tool-packages.mjs';
import { discoverPublicToolPackages } from './utils/tool-packages.mjs';

const rootDirectory = path.resolve(import.meta.dirname, '..');
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Publishes missing npm versions for released public tools on the current commit's first-parent history.
 *
 * Historical packages are packed from their exact release commits, in commit order, so a later
 * release can depend on an earlier one that this workflow run missed.
 *
 * @throws {Error} When GitHub release records, Git history, npm registry data, or package publication is invalid.
 */
async function main() {
    const targetSha = requiredEnvironment('RELEASE_TARGET_SHA');
    const repository = requiredEnvironment('GH_REPO');
    const tools = discoverPublicToolPackages(rootDirectory);
    const componentPaths = toolsByComponent(tools);
    const targetCommitOrder = firstParentCommitOrder(targetSha);
    const currentCommitPosition = targetCommitOrder.get(targetSha);
    if (currentCommitPosition === undefined) {
        throw new Error(`release target ${targetSha} is not in its own first-parent history`);
    }

    const publishedReleaseTags = listPublishedReleaseTags(repository);
    const gitTags = new Set(git('tag', '--list').split(/\r?\n/).filter(Boolean));
    const historicalReleases = [];
    for (const [component, packagePath] of componentPaths) {
        const prefix = `${component}-v`;
        for (const tag of publishedReleaseTags) {
            if (!tag.startsWith(prefix)) continue;
            if (!gitTags.has(tag)) throw new Error(`GitHub release ${tag} has no matching local Git tag`);
            const version = tag.slice(prefix.length);
            if (!VERSION_PATTERN.test(version)) {
                throw new Error(`public tool release tag ${tag} has an invalid semantic version`);
            }
            const sha = git('rev-parse', '--verify', `${tag}^{commit}`).trim();
            const position = targetCommitOrder.get(sha);
            if (position === undefined || position === currentCommitPosition) continue;
            historicalReleases.push({ path: packagePath, tag, version, sha, position });
        }
    }

    if (historicalReleases.length === 0) {
        console.log('No earlier public tool releases need catch-up.');
        return;
    }

    const versionsByPackage = new Map(
        await Promise.all(
            tools
                .filter(({ path: packagePath }) => historicalReleases.some((release) => release.path === packagePath))
                .map(
                    async ({ path: packagePath, name }) =>
                        /** @type {[string, Set<string>]} */ ([
                            packagePath,
                            new Set(await getNpmRegistryVersions(name)),
                        ]),
                ),
        ),
    );
    const pendingReleases = historicalReleases.filter(
        ({ path: packagePath, version }) => !versionsByPackage.get(packagePath).has(version),
    );

    if (pendingReleases.length === 0) {
        console.log(`Checked ${historicalReleases.length} earlier public tool release(s); all are already on npm.`);
        return;
    }

    const groupsByCommit = new Map();
    for (const release of pendingReleases) {
        const group = groupsByCommit.get(release.sha) ?? { sha: release.sha, position: release.position, releases: [] };
        if (group.releases.some(({ path: existingPath }) => existingPath === release.path)) {
            throw new Error(`multiple release tags for ${release.path} target the same commit ${release.sha}`);
        }
        group.releases.push(release);
        groupsByCommit.set(release.sha, group);
    }

    const groups = [...groupsByCommit.values()].sort((left, right) => left.position - right.position);
    console.log(
        `Catching up ${pendingReleases.length} unpublished public tool release(s) across ${groups.length} commit(s).`,
    );
    for (const group of groups) await publishReleaseGroup(group);
}

async function publishReleaseGroup(group) {
    const worktree = path.join(os.tmpdir(), `pumpkin-tool-release-${group.sha}-${randomUUID()}`);
    git('worktree', 'add', '--detach', worktree, group.sha);
    try {
        execFileSync('pnpm', ['install', '--frozen-lockfile'], {
            cwd: worktree,
            stdio: 'inherit',
        });
        const releaseMetadata = Object.fromEntries(
            group.releases.map(({ path: packagePath, tag }) => [`${packagePath}--tag_name`, tag]),
        );
        await publishToolPackages({
            root: worktree,
            selectedPaths: group.releases.map(({ path: packagePath }) => packagePath),
            releaseMetadata,
        });
    } finally {
        git('worktree', 'remove', '--force', worktree);
    }
}

function firstParentCommitOrder(targetSha) {
    const commits = git('rev-list', '--first-parent', '--reverse', targetSha).split(/\r?\n/).filter(Boolean);
    return new Map(commits.map((sha, index) => [sha, index]));
}

function listPublishedReleaseTags(repository) {
    const output = execFileSync(
        'gh',
        [
            'api',
            '--paginate',
            `repos/${repository}/releases?per_page=100`,
            '--jq',
            '.[] | select(.draft == false) | .tag_name | strings',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    );
    return new Set(output.split(/\r?\n/).filter(Boolean));
}

function toolsByComponent(tools) {
    const result = new Map();
    for (const { path: packagePath } of tools) {
        const component = path.posix.basename(packagePath);
        if (result.has(component)) throw new Error(`public tool release component is duplicated: ${component}`);
        result.set(component, packagePath);
    }
    return result;
}

function git(...args) {
    return execFileSync('git', args, { cwd: rootDirectory, encoding: 'utf8' });
}

function requiredEnvironment(name) {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

if (import.meta.main) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
