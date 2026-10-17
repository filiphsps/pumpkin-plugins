import { resolve } from 'node:path';
import { discoverComponents } from '@pumpkin-plugins/docs/node';
import {
    recoverExistingReleases,
    recoverIncompleteNativeReleases,
    recoverIncompletePluginReleases,
} from './release-recovery.mjs';
import { discoverPublicToolPackages } from './tool-packages.mjs';

/**
 * Routes Release Please components to plugin artifacts, action workflows, npm publication, and VSIX assets.
 *
 * @param {Array<{ path: string }>} releases - Components released at the current commit.
 * @param {string} [root] - Workspace root used to find public tool packages.
 * @returns {{ pluginPaths: string[], actionPaths: string[], toolPaths: string[], extensionPaths: string[], nativePaths: string[] }} Release paths grouped by publisher.
 * @throws {Error} When a configured release path has no publisher.
 */
export function partitionReleasePaths(releases, root = resolve(import.meta.dirname, '../..')) {
    const result = { pluginPaths: [], actionPaths: [], toolPaths: [], extensionPaths: [], nativePaths: [] };
    const nativePaths = new Set(discoverComponents(root, 'native').map(({ slug }) => `native/${slug}`));
    const publicToolPaths = new Set(discoverPublicToolPackages(root).map(({ path: packagePath }) => packagePath));
    for (const release of releases) {
        if (nativePaths.has(release.path)) result.nativePaths.push(release.path);
        else if (release.path.startsWith('actions/')) result.actionPaths.push(release.path);
        else if (release.path.startsWith('packages/')) result.pluginPaths.push(release.path);
        else if (publicToolPaths.has(release.path)) result.toolPaths.push(release.path);
        else if (release.path.startsWith('extensions/')) result.extensionPaths.push(release.path);
        else throw new Error(`No release publisher is configured for ${release.path}`);
    }
    return result;
}

/**
 * Selects releases for this commit and routes each one to its publisher.
 *
 * @param {object} options - Release state and the GitHub release lookup.
 * @param {Array<object>} options.createdReleases - Releases returned by Release Please.
 * @param {Record<string, object>} options.repositoryConfig - Release Please configuration by component path.
 * @param {Record<string, string>} options.releasedVersions - Latest published version by component path.
 * @param {string | undefined} options.currentSha - Commit built by this workflow run.
 * @param {(tagName: string) => Promise<object | undefined>} options.findRelease - Looks up a GitHub release by tag.
 * @param {Array<object>} [options.existingReleases] - Existing GitHub releases to inspect for missing plugin assets.
 * @param {Set<string>} [options.firstParentShas] - Commits on this run's first-parent history.
 * @param {(tagName: string) => Promise<{ assets: string[], immutable?: boolean }>} [options.getReleaseAssets] - Reads asset names and mutability for a GitHub release.
 * @param {string} options.root - Workspace root used to find public npm packages.
 * @param {boolean} [options.toolOnly] - Whether to include only npm tool releases for an explicit recovery run.
 * @param {(message: string) => void} [options.log] - Receives recovery and deferral messages.
 * @returns {Promise<{ releases: object[], paths: ReturnType<typeof partitionReleasePaths> }>} Releases and publisher paths for this commit.
 * @throws {Error} When a release has no target commit SHA or a tool-only replay finds no matching tool release.
 */
export async function collectReleaseFanout({
    createdReleases,
    repositoryConfig,
    releasedVersions,
    currentSha,
    findRelease,
    existingReleases = [],
    firstParentShas = new Set(currentSha ? [currentSha] : []),
    getReleaseAssets,
    root,
    toolOnly = false,
    log = console.log,
}) {
    const candidates = await recoverExistingReleases({
        releases: createdReleases,
        repositoryConfig,
        releasedVersions,
        currentSha,
        findRelease,
    });
    candidates.push(
        ...(await recoverIncompletePluginReleases({
            releases: candidates,
            existingReleases,
            repositoryConfig,
            firstParentShas,
            getReleaseAssets,
            log,
        })),
    );
    candidates.push(
        ...(await recoverIncompleteNativeReleases({
            releases: candidates,
            existingReleases,
            repositoryConfig,
            firstParentShas,
            getReleaseAssets,
            log,
        })),
    );
    const releases = [];
    for (const release of candidates) {
        if (!release.sha) throw new Error(`Release ${release.tagName} has no target commit SHA`);
        if (release.recovered) log(`Recovering ${release.tagName} for artifact fan-out at ${release.sha}`);
        if (release.sha === currentSha || release.rebuildFromTag) {
            releases.push(release);
            continue;
        }
        log(
            `Deferring ${release.tagName} from artifact fan-out: tag targets ${release.sha}, but this run built ${currentSha}`,
        );
    }

    const paths = partitionReleasePaths(releases, root);
    if (!toolOnly) return { releases, paths };

    const toolPaths = new Set(paths.toolPaths);
    const toolReleases = releases.filter(({ path }) => toolPaths.has(path));
    if (toolReleases.length === 0) {
        throw new Error(`No npm tool release targets requested commit ${currentSha}`);
    }
    return {
        releases: toolReleases,
        paths: {
            pluginPaths: [],
            actionPaths: [],
            toolPaths: toolReleases.map(({ path }) => path),
            extensionPaths: [],
            nativePaths: [],
        },
    };
}
