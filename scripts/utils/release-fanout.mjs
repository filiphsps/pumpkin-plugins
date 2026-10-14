import { PUBLIC_TOOL_PACKAGE_PATHS } from './tool-packages.mjs';

/**
 * Routes Release Please components to plugin artifact, action, and npm publication jobs.
 *
 * @param {Array<{ path: string }>} releases - Components released at the current commit.
 * @returns {{ pluginPaths: string[], actionPaths: string[], toolPaths: string[] }} Release paths grouped by publisher.
 * @throws {Error} When a configured release path has no publisher.
 */
export function partitionReleasePaths(releases) {
    const result = { pluginPaths: [], actionPaths: [], toolPaths: [] };
    for (const release of releases) {
        if (release.path.startsWith('actions/')) result.actionPaths.push(release.path);
        else if (release.path.startsWith('packages/')) result.pluginPaths.push(release.path);
        else if (Object.hasOwn(PUBLIC_TOOL_PACKAGE_PATHS, release.path)) result.toolPaths.push(release.path);
        else throw new Error(`No release publisher is configured for ${release.path}`);
    }
    return result;
}
