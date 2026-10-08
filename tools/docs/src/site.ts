/**
 * Derives the GitHub Pages base URL from repository metadata.
 * @internal Used by the README generator and VitePress configuration.
 * @param repository - A GitHub repository URL or package repository field.
 * @returns The Pages base URL, or `undefined` when the repository is not on GitHub.
 */
export function githubPagesUrl(repository: unknown): URL | undefined {
    const rawUrl =
        typeof repository === 'string'
            ? repository
            : repository && typeof repository === 'object' && 'url' in repository
              ? (repository as { url?: unknown }).url
              : undefined;
    if (typeof rawUrl !== 'string') return undefined;

    const normalized = rawUrl.replace(/^git\+/, '').replace(/\.git$/, '');
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(normalized);
    if (!match) return undefined;

    const [, owner, repositoryName] = match;
    const host = `${owner.toLowerCase()}.github.io`;
    const basePath = repositoryName.toLowerCase() === host ? '/' : `${encodeURIComponent(repositoryName)}/`;
    return new URL(basePath, `https://${host}/`);
}
