import { recoverExistingReleases } from './release-recovery.mjs';
import { discoverPublicToolPackages } from './tool-packages.mjs';

/**
 * Routes Release Please components to plugin artifacts, action workflows, npm publication, and VSIX assets.
 *
 * @param {Array<{ path: string }>} releases - Components released at the current commit.
 * @param {string} [root] - Workspace root used to find public tool packages.
 * @returns {{ pluginPaths: string[], actionPaths: string[], toolPaths: string[], extensionPaths: string[] }} Release paths grouped by publisher.
 * @throws {Error} When a configured release path has no publisher.
 */
export function partitionReleasePaths(releases, root) {
    const result = { pluginPaths: [], actionPaths: [], toolPaths: [], extensionPaths: [] };
    const publicToolPaths = new Set(discoverPublicToolPackages(root).map(({ path: packagePath }) => packagePath));
    for (const release of releases) {
        if (release.path.startsWith('actions/')) result.actionPaths.push(release.path);
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
 * @param {string} options.root - Workspace root used to find public npm packages.
 * @param {(message: string) => void} [options.log] - Receives recovery and deferral messages.
 * @returns {Promise<{ releases: object[], paths: ReturnType<typeof partitionReleasePaths> }>} Releases and publisher paths for this commit.
 * @throws {Error} When a release has no target commit SHA.
 */
export async function collectReleaseFanout({
    createdReleases,
    repositoryConfig,
    releasedVersions,
    currentSha,
    findRelease,
    root,
    log = console.log,
}) {
    const candidates = await recoverExistingReleases({
        releases: createdReleases,
        repositoryConfig,
        releasedVersions,
        currentSha,
        findRelease,
    });
    const releases = [];
    for (const release of candidates) {
        if (!release.sha) throw new Error(`Release ${release.tagName} has no target commit SHA`);
        if (release.recovered) log(`Recovering ${release.tagName} for artifact fan-out at ${release.sha}`);
        if (release.sha === currentSha) {
            releases.push(release);
            continue;
        }
        log(
            `Deferring ${release.tagName} from artifact fan-out: tag targets ${release.sha}, but this run built ${currentSha}`,
        );
    }

    return { releases, paths: partitionReleasePaths(releases, root) };
}
