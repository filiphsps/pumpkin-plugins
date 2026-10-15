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

function isImmutableReleaseConflict(error) {
    return (
        error?.status === 422 &&
        Array.isArray(error.body?.errors) &&
        error.body.errors.some(
            (problem) =>
                problem.field === 'tag_name' && problem.message?.includes('tag_name was used by an immutable release'),
        )
    );
}

/**
 * Reuses existing releases after Release Please rejects an immutable tag.
 *
 * @param {object} options - The conflict and operations for resolving existing releases.
 * @param {object} options.error - Error raised while creating GitHub releases.
 * @param {() => Array<{ tagName: string, sha: string, path: string, version: string, major: number, minor: number, patch: number }> | undefined} options.getCandidates - Returns candidates normalized by the Release Please adapter.
 * @param {number | undefined} options.pullRequestNumber - Release PR whose labels may be updated.
 * @param {boolean} options.labelingEnabled - Whether Release Please label updates are enabled.
 * @param {(tagName: string) => Promise<object | undefined>} options.findRelease - Looks up a GitHub release by tag.
 * @param {(pullRequestNumber: number) => Promise<void>} options.restoreLabels - Replaces pending labels with release labels.
 * @returns {Promise<Array<object>>} Existing releases with their Release Please metadata.
 * @throws {Error} For unrelated errors, missing or mismatched tags, or failed label restoration.
 */
export async function recoverImmutableReleaseConflict({
    error,
    getCandidates,
    pullRequestNumber,
    labelingEnabled,
    findRelease,
    restoreLabels,
}) {
    if (!isImmutableReleaseConflict(error)) throw error;

    const candidates = getCandidates();
    if (!Array.isArray(candidates)) {
        throw new Error('Could not resolve release candidates for an existing tag', { cause: error });
    }

    const recovered = [];
    for (const candidate of candidates) {
        const release = await findRelease(candidate.tagName);
        if (!release) {
            throw new Error(`GitHub rejected ${candidate.tagName} as a duplicate, but no existing release was found`, {
                cause: error,
            });
        }
        if (release.sha !== candidate.sha) {
            throw new Error(
                `GitHub release ${candidate.tagName} points to ${release.sha}, but Release Please expects ${candidate.sha}`,
                { cause: error },
            );
        }
        recovered.push({
            ...release,
            path: candidate.path,
            version: candidate.version,
            major: candidate.major,
            minor: candidate.minor,
            patch: candidate.patch,
            prNumber: pullRequestNumber,
            recovered: true,
        });
    }

    if (pullRequestNumber && labelingEnabled) await restoreLabels(pullRequestNumber);
    return recovered;
}
