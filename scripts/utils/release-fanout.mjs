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
