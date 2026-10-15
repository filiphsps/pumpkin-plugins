// biome-ignore lint/suspicious/noTemplateCurlyInString: Release Please requires literal placeholders in this pattern.
const DEFAULT_RELEASE_TITLE_PATTERN = 'chore${scope}: release${component} ${version}';

/**
 * Allows Release Please to parse merged release titles that use its default spacing.
 *
 * @param {object} manifest - Release-creation manifest whose merged release PRs are parsed.
 */
export function enableLegacyReleaseTitleParsing(manifest) {
    // Preserve Release Please's previous default so migrated custom patterns can still parse old PRs.
    manifest.groupPullRequestTitlePattern ??= DEFAULT_RELEASE_TITLE_PATTERN;
    for (const config of Object.values(manifest.repositoryConfig)) config.componentNoSpace = false;
}
