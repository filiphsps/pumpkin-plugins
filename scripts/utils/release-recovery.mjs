/**
 * Adds existing releases for configured component versions when they target the current commit.
 *
 * @param {object} options - Release state and a lookup for existing GitHub releases.
 * @param {Array<object>} options.releases - Releases already created by Release Please.
 * @param {Record<string, object>} options.repositoryConfig - Release Please configuration by component path.
 * @param {Record<string, string>} options.releasedVersions - Latest published version by component path.
 * @param {string | undefined} options.currentSha - Commit built by this workflow run.
 * @param {(tagName: string) => Promise<object | undefined>} options.findRelease - Looks up a GitHub release by tag.
 * @returns {Promise<Array<object>>} Newly created releases plus matching existing releases, once per tag.
 */
export async function recoverExistingReleases({
    releases,
    repositoryConfig,
    releasedVersions,
    currentSha,
    findRelease,
}) {
    const recoveredReleases = [...releases];
    const knownTags = new Set(releases.map(({ tagName }) => tagName));
    if (!currentSha) return recoveredReleases;

    for (const [path, config] of Object.entries(repositoryConfig)) {
        const version = releasedVersions[path]?.toString();
        if (!version || config.skipGithubRelease) continue;
        const component = config.includeComponentInTag === false ? '' : config.component;
        if (component === undefined) continue;
        const prefix = component ? `${component}${config.tagSeparator ?? '-'}` : '';
        const tagName = `${prefix}${config.includeVInTag === false ? '' : 'v'}${version}`;
        if (knownTags.has(tagName)) continue;
        const release = await findRelease(tagName);
        if (release?.sha !== currentSha) continue;
        recoveredReleases.push({ ...release, path, version, recovered: true });
        knownTags.add(tagName);
    }

    return recoveredReleases;
}
