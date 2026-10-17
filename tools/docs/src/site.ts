import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { type ComponentGroup, discoverComponents, walkMarkdown } from './discovery.ts';

/** VitePress source pages whose public routes are at the documentation site root. */
export const rootPageRewrites = {
    'docs/index.md': 'index.md',
    'docs/team.md': 'team.md',
} as const;

/** A hand-written page assigned to the Guides or Docs section of the site. */
export interface HandwrittenDocPage {
    category?: string;
    description: string;
    file: string;
    relativePath: string;
    repositoryPath: string;
    rewritePath: string;
    section: 'docs' | 'guides';
    siteRoute: string;
    title: string;
    treePath: string;
    type?: 'card' | 'link' | 'spotlight';
}

/** A documentation page shown as a leaf in a folder tree. */
export interface DocumentationTreePage {
    description: string;
    file: string;
    kind: 'page';
    link: string;
    relativePath: string;
    text: string;
    type?: 'card' | 'link' | 'spotlight';
}

/** A source folder and its pages; its index page is the folder's optional landing link. */
export interface DocumentationTreeFolder {
    description?: string;
    indexFile?: string;
    indexPath?: string;
    items: DocumentationTreeNode[];
    kind: 'folder';
    link?: string;
    relativePath: string;
    text: string;
}

/** One page or folder in the hand-written Docs tree. */
export type DocumentationTreeNode = DocumentationTreeFolder | DocumentationTreePage;

/** Read frontmatter from a Markdown file, returning an empty object when none is present. */
function frontmatterOf(file: string): Record<string, unknown> {
    const source = readFileSync(file, 'utf8');
    const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
    if (!frontmatter) return {};
    const value: unknown = parse(frontmatter[1] ?? '');
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** Return a readable title from frontmatter, the first H1, or the source filename. */
function titleOf(file: string, fallback: string): string {
    const frontmatterTitle = frontmatterOf(file).title;
    if (typeof frontmatterTitle === 'string' && frontmatterTitle.trim()) return frontmatterTitle.trim();
    const heading = readFileSync(file, 'utf8')
        .match(/^#\s+(.+)$/m)?.[1]
        ?.trim();
    return heading?.replace(/\s+#*$/, '') || fallback;
}

/** Derive a short page description from frontmatter or the first prose paragraph. */
function descriptionOf(file: string): string {
    const description = frontmatterOf(file).description;
    if (typeof description === 'string') return description;
    const source = readFileSync(file, 'utf8')
        .replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '')
        .replace(/^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[ \t]*$/gm, '')
        .replace(/^[ \t]*~~~[^\n]*\n[\s\S]*?^[ \t]*~~~[ \t]*$/gm, '');
    const prose = source
        .replace(/^#\s+.+$/m, '')
        .split(/\n\s*\n/)
        .map((paragraph) => paragraph.trim())
        .find((paragraph) => paragraph && !/^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|)/.test(paragraph));
    const text = (prose ?? '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[`*_>#]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/:\s*$/, '.');
    const sentenceEnd = text.search(/[.!?](?=\s+[A-Z])/);
    const summary = sentenceEnd === -1 ? text : text.slice(0, sentenceEnd + 1);
    if (summary.length <= 180) return summary;
    const truncated = summary.slice(0, 179);
    const wordEnd = truncated.lastIndexOf(' ');
    return `${truncated.slice(0, wordEnd > 0 ? wordEnd : truncated.length).trimEnd()}…`;
}

/** Read the navigation category and card treatment from a page's frontmatter. */
function navigationOf(file: string): { category?: string; type?: HandwrittenDocPage['type'] } {
    const navigation = frontmatterOf(file).navigation;
    if (!navigation || typeof navigation !== 'object') return {};
    const metadata = navigation as Record<string, unknown>;
    const category =
        typeof metadata.category === 'string' && metadata.category.trim() ? metadata.category.trim() : undefined;
    const type =
        metadata.type === 'link' || metadata.type === 'card' || metadata.type === 'spotlight'
            ? metadata.type
            : undefined;
    return { ...(category ? { category } : {}), ...(type ? { type } : {}) };
}

/** Whether a component page opts in to the repository-level Docs menu and catalog. */
function isCataloguedComponentDoc(file: string): boolean {
    const navigation = frontmatterOf(file).navigation;
    if (!navigation || typeof navigation !== 'object') return false;
    return (navigation as Record<string, unknown>).catalog === true;
}

/**
 * Discover hand-written site pages and assign each page its canonical site route.
 * Direct children of `docs/` become Guides, deeper pages become Docs, and root pages plus generated API pages are omitted.
 * @param root - The repository root.
 * @returns Pages in stable source-path order.
 */
export function discoverHandwrittenDocs(root: string): HandwrittenDocPage[] {
    const rootDocsDirectory = path.resolve(root, 'docs');
    const rootPages = new Set(Object.keys(rootPageRewrites).map((source) => source.slice('docs/'.length)));
    const docsPages = walkMarkdown(rootDocsDirectory, { exclude: [path.join(rootDocsDirectory, 'api')] }).flatMap(
        (file) => {
            const relativePath = path.relative(rootDocsDirectory, file).split(path.sep).join('/');
            if (relativePath === 'README.md' || rootPages.has(relativePath)) return [];
            const section: HandwrittenDocPage['section'] = relativePath.includes('/') ? 'docs' : 'guides';
            const routePath = relativePath.replace(/\.md$/, '');
            const siteRoute =
                section === 'guides'
                    ? `/guides/${routePath}`
                    : relativePath.endsWith('/index.md')
                      ? `/docs/${routePath.slice(0, -'index'.length)}`
                      : `/docs/${routePath}`;
            const metadata = navigationOf(file);
            return [
                {
                    file,
                    relativePath,
                    repositoryPath: path.relative(root, file).split(path.sep).join('/'),
                    treePath: relativePath,
                    section,
                    siteRoute,
                    rewritePath: `${section === 'guides' ? 'guides' : 'docs'}/${relativePath}`,
                    title: titleOf(file, path.basename(file, '.md')),
                    description: descriptionOf(file),
                    ...metadata,
                },
            ];
        },
    );
    const componentDocs = (['packages', 'tools', 'actions', 'extensions', 'native'] as const).flatMap((group) => {
        return discoverComponents(root, group).flatMap(({ directory, slug }) => {
            const componentDocsDirectory = path.join(directory, 'docs');
            return walkMarkdown(componentDocsDirectory).flatMap((file) => {
                if (!isCataloguedComponentDoc(file)) return [];
                const pathFromComponentDocs = path.relative(componentDocsDirectory, file).split(path.sep).join('/');
                const relativePath = path.relative(rootDocsDirectory, file).split(path.sep).join('/');
                const repositoryPath = path.relative(root, file).split(path.sep).join('/');
                const treePath = `${group}/${slug}/${pathFromComponentDocs}`;
                const route = `${group}/${slug}/docs/${pathFromComponentDocs.replace(/\.md$/, '')}`;
                return [
                    {
                        file,
                        relativePath,
                        repositoryPath,
                        treePath,
                        section: 'docs' as const,
                        siteRoute: `/${route}`,
                        rewritePath: repositoryPath,
                        title: titleOf(file, path.basename(file, '.md')),
                        description: descriptionOf(file),
                        ...navigationOf(file),
                    },
                ];
            });
        });
    });
    return [...docsPages, ...componentDocs];
}

/**
 * Build a recursive folder tree from pages assigned to the Docs section.
 * @param pages - Discovered Guides and Docs pages.
 * @returns Top-level documentation folders and their nested pages.
 */
export function buildDocumentationTree(pages: readonly HandwrittenDocPage[]): DocumentationTreeFolder[] {
    interface FolderBuilder {
        children: Map<string, FolderBuilder>;
        pages: HandwrittenDocPage[];
        relativePath: string;
    }
    const root: FolderBuilder = { children: new Map(), pages: [], relativePath: '' };
    for (const page of pages.filter(({ section }) => section === 'docs')) {
        const folderNames = page.treePath.split('/').slice(0, -1);
        let folder = root;
        for (const name of folderNames) {
            const relativePath = folder.relativePath ? `${folder.relativePath}/${name}` : name;
            let child = folder.children.get(name);
            if (!child) {
                child = { children: new Map(), pages: [], relativePath };
                folder.children.set(name, child);
            }
            folder = child;
        }
        folder.pages.push(page);
    }

    function finish(folder: FolderBuilder): DocumentationTreeFolder {
        const index = folder.pages.find((page) => page.treePath === `${folder.relativePath}/index.md`);
        const pages = folder.pages
            .filter((page) => page !== index)
            .sort((left, right) => left.title.localeCompare(right.title))
            .map(
                (page): DocumentationTreePage => ({
                    kind: 'page',
                    text: page.title,
                    description: page.description,
                    link: page.siteRoute,
                    file: page.file,
                    relativePath: page.relativePath,
                    ...(page.type ? { type: page.type } : {}),
                }),
            );
        const nested = [...folder.children.values()]
            .map(finish)
            .sort((left, right) => left.text.localeCompare(right.text));
        const categories = [
            ...new Set(folder.pages.map(({ category }) => category).filter((value): value is string => !!value)),
        ];
        const fallback = folder.relativePath.split('/').at(-1) ?? '';
        const text = index?.title ?? (categories.length === 1 ? categories[0] : humanizeFolder(fallback));
        return {
            kind: 'folder',
            text,
            relativePath: folder.relativePath,
            ...(index ? { link: index.siteRoute, indexFile: index.file, description: index.description } : {}),
            ...(index ? { indexPath: index.relativePath } : {}),
            items: [...pages, ...nested],
        };
    }

    return [...root.children.values()].map(finish).sort((left, right) => left.text.localeCompare(right.text));
}

/** Convert a folder name to a readable label when it has no index title or category. */
function humanizeFolder(value: string): string {
    return value
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
        .join(' ');
}

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
