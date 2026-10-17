import { nativeAssetNames, nativeTargets } from './native-targets.mjs';

const PLUGIN_PATH_PATTERN = /^packages\/[^/]+$/;
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

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

/**
 * Finds plugin releases on this branch that still need their GitHub asset pair.
 *
 * @param {object} options - Existing release state and asset inspection operations.
 * @param {Array<object>} options.releases - Releases already selected for this run.
 * @param {Array<object>} options.existingReleases - GitHub releases found in repository history.
 * @param {Record<string, object>} options.repositoryConfig - Release Please configuration by component path.
 * @param {Set<string>} options.firstParentShas - Commit SHAs on the target's first-parent history.
 * @param {(tagName: string) => Promise<{ assets: string[], immutable?: boolean }>} options.getReleaseAssets - Reads assets and mutability for a published release.
 * @param {(message: string) => void} [options.log] - Receives catch-up messages.
 * @returns {Promise<Array<object>>} Incomplete plugin releases that can be rebuilt from their own tags.
 * @throws {Error} When a plugin tag is ambiguous or its release assets cannot be inspected.
 */
export async function recoverIncompletePluginReleases({
    releases,
    existingReleases,
    repositoryConfig,
    firstParentShas,
    getReleaseAssets,
    log = console.log,
}) {
    const knownTags = new Set(releases.map(({ tagName }) => tagName));
    const recovered = [];

    for (const release of existingReleases) {
        if (!release.tagName || !release.sha || knownTags.has(release.tagName) || !firstParentShas.has(release.sha)) {
            continue;
        }

        const matches = [];
        for (const [path, config] of Object.entries(repositoryConfig)) {
            if (!PLUGIN_PATH_PATTERN.test(path) || config.skipGithubRelease) continue;
            if (config.includeComponentInTag !== false && typeof config.component !== 'string') continue;

            const component = config.includeComponentInTag === false ? '' : config.component;
            const prefix =
                (component ? component + (config.tagSeparator ?? '-') : '') +
                (config.includeVInTag === false ? '' : 'v');
            if (!release.tagName.startsWith(prefix)) continue;

            const version = release.tagName.slice(prefix.length);
            if (RELEASE_VERSION_PATTERN.test(version)) matches.push({ path, version, prefix });
        }

        if (matches.length === 0) continue;
        matches.sort((left, right) => right.prefix.length - left.prefix.length);
        if (matches[1]?.prefix.length === matches[0].prefix.length) {
            throw new Error(`Plugin release tag ${release.tagName} matches multiple configured plugins`);
        }

        const { path, version } = matches[0];
        const details = await getReleaseAssets(release.tagName);
        if (!Array.isArray(details.assets)) {
            throw new Error(`Could not inspect GitHub assets for plugin release ${release.tagName}`);
        }

        const pluginName = path.slice('packages/'.length);
        const wasmName = `${pluginName}.wasm`;
        const checksumName = `${wasmName}.sha256`;
        const hasWasm = details.assets.includes(wasmName);
        const hasChecksum = details.assets.includes(checksumName);

        if (hasWasm !== hasChecksum) {
            log(
                `Warning: Skipping ${release.tagName}; it has only one of ${wasmName} and ${checksumName}. ` +
                    'Repair the partial asset pair before retrying.',
            );
            continue;
        }
        if (hasWasm) {
            knownTags.add(release.tagName);
            continue;
        }
        if (details.immutable) {
            log(`Warning: Skipping ${release.tagName}; the immutable release cannot accept its missing plugin assets.`);
            continue;
        }

        recovered.push({
            ...release,
            path,
            version,
            recovered: true,
            rebuildFromTag: true,
        });
        log(`Recovering incomplete plugin release ${release.tagName} from its tagged commit ${release.sha}`);
        knownTags.add(release.tagName);
    }

    return recovered;
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

/** Recover incomplete native matrices from their own tags, including mutable partial uploads. */
export async function recoverIncompleteNativeReleases({
    releases,
    existingReleases,
    repositoryConfig,
    firstParentShas,
    getReleaseAssets,
    log = console.log,
}) {
    const knownTags = new Set(releases.map(({ tagName }) => tagName));
    const recovered = [];
    for (const release of existingReleases) {
        if (!release.tagName || !firstParentShas.has(release.sha) || knownTags.has(release.tagName)) continue;
        const matches = Object.entries(repositoryConfig).flatMap(([path, config]) => {
            if (!/^native\/[^/]+$/.test(path) || config.skipGithubRelease) return [];
            const component = path.split('/').at(-1);
            if (
                config.component !== component ||
                config.includeComponentInTag === false ||
                config.includeVInTag === false ||
                (config.tagSeparator && config.tagSeparator !== '-')
            ) {
                throw new Error(`Native release ${path} requires its independent ${component}-v<version> tag stream`);
            }
            const prefix = `${component}-v`;
            const version = release.tagName.slice(prefix.length);
            return release.tagName.startsWith(prefix) && RELEASE_VERSION_PATTERN.test(version)
                ? [{ path, component, version }]
                : [];
        });
        if (matches.length === 0) continue;
        if (matches.length !== 1) throw new Error(`Ambiguous native release tag ${release.tagName}`);
        const [{ path, component, version }] = matches;
        const details = await getReleaseAssets(release.tagName);
        if (!Array.isArray(details.assets))
            throw new Error(`Could not inspect GitHub assets for native release ${release.tagName}`);
        const expected = nativeTargets.flatMap(({ target }) => nativeAssetNames(component, target));
        if (expected.every((name) => details.assets.includes(name))) continue;
        if (details.immutable) {
            log(
                `Warning: Skipping incomplete immutable native release ${release.tagName}; GitHub prevents repairing its assets.`,
            );
            continue;
        }
        recovered.push({ ...release, path, version, recovered: true, rebuildFromTag: true });
        knownTags.add(release.tagName);
    }
    return recovered;
}
