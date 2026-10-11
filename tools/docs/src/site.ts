import type { ComponentGroup } from './discovery.ts';

/** Normalize a GitHub repository URL from a package repository field. */
export function githubRepositoryUrl(repository: unknown): URL | undefined {
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

    return new URL(normalized);
}

/** Derive a project or user GitHub Pages base URL from repository metadata. */
export function githubPagesUrl(repository: unknown): URL | undefined {
    const source = githubRepositoryUrl(repository);
    if (!source) return undefined;
    const [owner, repositoryName] = source.pathname.slice(1).split('/');
    const host = `${owner.toLowerCase()}.github.io`;
    const basePath = repositoryName.toLowerCase() === host ? '/' : `${encodeURIComponent(repositoryName)}/`;
    return new URL(basePath, `https://${host}/`);
}

/** Derive one component API route shared by generated links, the API builder and the site. */
export function componentApiRoute(group: ComponentGroup, slug: string, name = slug): string {
    const category = group === 'packages' ? 'plugins' : group;
    return `api/${category}/${group === 'tools' ? name : slug}/`;
}
