import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
    buildDocumentationTree,
    type ComponentGroup,
    componentApiRoute,
    type DocumentationTreeNode,
    discoverComponents,
    discoverHandwrittenDocs,
    githubPagesUrl,
    githubRepositoryUrl,
    readActionMetadata,
    readNativeManifest,
    rootPageRewrites,
    walkMarkdown,
} from '@pumpkin-plugins/docs/node';
import { type DefaultTheme, defineConfig } from 'vitepress';
import { parse as parseYaml } from 'yaml';
import type { MegaMenu, MenuCard, MenuItem, MenuSection, ThemeConfigWithMegaMenus } from './theme/types.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const repository = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).repository;
const repoUrl = githubRepositoryUrl(repository)?.href;
if (!repoUrl) throw new Error('Root package.json needs a GitHub repository URL');
const siteUrl = githubPagesUrl(repository);
const siteBase = siteUrl?.pathname ?? '/';

function titleOf(file: string, fallback: string): string {
    const title = frontmatterOf(file).title;
    if (typeof title === 'string' && title.trim()) return title.trim();
    const heading = fs
        .readFileSync(file, 'utf8')
        .match(/^#\s+(.+)$/m)?.[1]
        ?.trim();
    return heading?.replace(/\s+#*$/, '') || fallback;
}

const handwrittenDocs = discoverHandwrittenDocs(repoRoot);
const docsTree = buildDocumentationTree(handwrittenDocs);
const rewrites: Record<string, string> = {
    ...rootPageRewrites,
    'docs/README.md': 'guides/index.md',
};
const navigationAssets = new Map<string, string>();

for (const page of handwrittenDocs) rewrites[page.repositoryPath] = page.rewritePath;
for (const file of walkMarkdown(path.join(repoRoot, 'docs/api'))) {
    const relative = path.relative(repoRoot, file).split(path.sep).join('/');
    rewrites[relative] = relative.slice('docs/'.length);
}
const sourcePathsByRoute = new Map(Object.entries(rewrites).map(([source, route]) => [route, source]));

interface Component {
    apiReference?: string;
    category?: string;
    customDocs: { file: string; title: string; route: string }[];
    description: string;
    featured: boolean;
    icon?: string;
    menuItemType?: MenuCard['type'];
    overview: string;
    readme?: string;
    slug: string;
    title: string;
}

function frontmatterOf(file: string): Record<string, unknown> {
    const source = fs.readFileSync(file, 'utf8');
    const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
    if (!frontmatter) return {};
    const value: unknown = parseYaml(frontmatter[1]);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function descriptionOf(file: string): string {
    const description = frontmatterOf(file).description;
    if (typeof description === 'string') return description;
    const source = fs
        .readFileSync(file, 'utf8')
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

function navigationMetadata(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || !('navigation' in value)) return {};
    const navigation = (value as { navigation?: unknown }).navigation;
    return navigation && typeof navigation === 'object' ? (navigation as Record<string, unknown>) : {};
}

function docsConfigOf(directory: string): Record<string, unknown> {
    const file = path.join(directory, 'docs.yml');
    if (!fs.existsSync(file)) return {};
    const value: unknown = parseYaml(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function categoryOf(value: unknown): string | undefined {
    const category = navigationMetadata(value).category;
    return typeof category === 'string' && category.trim() ? category.trim() : undefined;
}

function menuItemTypeOf(value: unknown): MenuCard['type'] | undefined {
    const type = navigationMetadata(value).type;
    return type === 'link' || type === 'card' || type === 'spotlight' ? type : undefined;
}

function components(group: ComponentGroup): Component[] {
    return discoverComponents(repoRoot, group).flatMap(({ slug, directory: source, metadataFile }) => {
        const readme = path.join(source, 'README.md');
        const docsDirectory = path.join(source, 'docs');
        const docsConfig = docsConfigOf(source);
        const docs = walkMarkdown(docsDirectory);
        const customIndex = docs.find((file) => path.relative(docsDirectory, file) === 'index.md');
        const firstCustomDoc = docs[0];
        const overview = customIndex
            ? `/${group}/${slug}/docs/index`
            : fs.existsSync(readme)
              ? `/${group}/${slug}/README`
              : firstCustomDoc
                ? `/${group}/${slug}/docs/${path
                      .relative(docsDirectory, firstCustomDoc)
                      .split(path.sep)
                      .join('/')
                      .replace(/\.md$/, '')}`
                : `/${group}/${slug}/README`;
        const headingSource = customIndex ?? (fs.existsSync(readme) ? readme : docs[0]);
        const manifest =
            group === 'native'
                ? readNativeManifest(metadataFile)
                : group !== 'actions'
                  ? JSON.parse(fs.readFileSync(metadataFile, 'utf8'))
                  : undefined;
        const actionManifest = group === 'actions' ? readActionMetadata(metadataFile) : undefined;
        const fallbackTitle = manifest?.name ?? slug;
        const title = headingSource ? titleOf(headingSource, fallbackTitle) : fallbackTitle;
        const description =
            manifest?.description ??
            actionManifest?.description ??
            (headingSource ? descriptionOf(headingSource) : '') ??
            '';
        const customIndexFrontmatter = customIndex ? frontmatterOf(customIndex) : {};
        const navigation = navigationMetadata(customIndexFrontmatter);
        const featured = Boolean('featured' in navigation && navigation.featured);
        const menuItemType = menuItemTypeOf(docsConfig) ?? menuItemTypeOf(customIndexFrontmatter);
        const category = categoryOf(docsConfig) ?? categoryOf(customIndexFrontmatter);
        const readmeRoute = fs.existsSync(readme) ? `/${group}/${slug}/README` : undefined;
        const iconCandidates = ['icon.svg', 'icon.png', 'icon.webp', 'logo.svg', 'logo.png', 'logo.webp'];
        const docsNavigation = navigationMetadata(docsConfig);
        const configuredIcon =
            typeof docsNavigation.icon === 'string' ? path.resolve(source, docsNavigation.icon) : undefined;
        const conventionalIcon = [source, docsDirectory]
            .flatMap((directory) => iconCandidates.map((filename) => path.join(directory, filename)))
            .find((file) => fs.existsSync(file));
        const iconFile = configuredIcon && fs.existsSync(configuredIcon) ? configuredIcon : conventionalIcon;
        const iconPath = iconFile ? path.relative(repoRoot, iconFile).split(path.sep).join('/') : undefined;
        if (iconPath && iconFile) navigationAssets.set(iconPath, iconFile);
        const icon = iconPath ? `/${iconPath}` : undefined;
        const apiRoute = componentApiRoute(group, slug, manifest?.name);
        const apiDirectory = path.join(repoRoot, 'docs', apiRoute);
        const apiReference = fs.existsSync(path.join(apiDirectory, 'index.md')) ? `/${apiRoute}` : undefined;

        const customDocs = docs.map((file) => {
            const relative = path.relative(docsDirectory, file).split(path.sep).join('/');
            const route = `${group}/${slug}/docs/${relative}`;
            return {
                file,
                title: titleOf(file, path.basename(file, '.md')),
                route: `/${route.replace(/\.md$/, '')}`,
            };
        });

        return [
            {
                slug,
                title,
                description,
                overview,
                category,
                icon,
                menuItemType,
                readme: readmeRoute,
                apiReference,
                featured,
                customDocs,
            },
        ];
    });
}

const plugins = components('packages');
const tools = components('tools');
const actions = components('actions');
const native = components('native');
const componentLandingIcons = new Map(
    [...plugins, ...tools, ...actions, ...native].flatMap((item) =>
        item.icon ? [[`${item.overview.slice(1)}.md`, item.icon] as const] : [],
    ),
);
const releaseConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'release-please-config.json'), 'utf8'));
const releaseTags = new Set(
    execFileSync('git', ['tag', '--list'], { cwd: repoRoot, encoding: 'utf8' }).trim().split('\n'),
);
const componentVersions = new Map<string, { version: string; release?: string }>();
for (const [group, items] of [
    ['packages', plugins],
    ['actions', actions],
    ['native', native],
] as const) {
    for (const item of items) {
        const directory = `${group}/${item.slug}`;
        const versionFile = path.join(
            repoRoot,
            directory,
            group === 'packages' ? 'package.json' : group === 'native' ? 'Cargo.toml' : 'version.txt',
        );
        if (!fs.existsSync(versionFile)) continue;
        const source = fs.readFileSync(versionFile, 'utf8');
        const version: string =
            group === 'packages'
                ? JSON.parse(source).version
                : group === 'native'
                  ? readNativeManifest(versionFile).version
                  : source.trim();
        if (!version) continue;
        const component = releaseConfig.packages[directory]?.component;
        const tag = component ? `${component}-v${version}` : undefined;
        const release = tag && releaseTags.has(tag) ? `${repoUrl}/releases/tag/${encodeURIComponent(tag)}` : undefined;
        const badge = { version, release };
        componentVersions.set(`${item.overview.slice(1)}.md`, badge);
        if (item.readme) componentVersions.set(`${item.readme.slice(1)}.md`, badge);
        if (item.apiReference) componentVersions.set(`${item.apiReference.slice(1)}index.md`, badge);
    }
}

const guidePages = handwrittenDocs
    .filter(({ section }) => section === 'guides')
    .map((page) => ({
        file: page.file,
        text: page.title,
        description: page.description,
        link: page.siteRoute,
        category: page.category,
        type: page.type,
    }));

interface LlmsEntry {
    description?: string;
    text: string;
    url: string;
}

const githubRepository = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(repoUrl)?.[1];
const rawRepositoryUrl = githubRepository ? `https://raw.githubusercontent.com/${githubRepository}/master` : undefined;
const publishedSiteUrl = siteUrl?.href;

function markdownSourceUrl(file: string): string {
    const relative = path.relative(repoRoot, file).split(path.sep).map(encodeURIComponent).join('/');
    return rawRepositoryUrl ? `${rawRepositoryUrl}/${relative}` : `${repoUrl}/blob/master/${relative}`;
}

function publishedPageUrl(route: string): string {
    const relative = route.replace(/^\/+/, '');
    return publishedSiteUrl ? new URL(relative, publishedSiteUrl).href : `${siteBase}${relative}`;
}

function componentOverviewFile(item: Component): string | undefined {
    const customOverview = item.customDocs.find((doc) => doc.route === item.overview);
    if (customOverview) return customOverview.file;
    if (item.readme !== item.overview) return undefined;
    const readme = path.resolve(repoRoot, `${item.overview.slice(1)}.md`);
    return fs.existsSync(readme) ? readme : undefined;
}

function componentLlmsEntries(item: Component): LlmsEntry[] {
    const entries: LlmsEntry[] = [];
    const overviewFile = componentOverviewFile(item);

    if (overviewFile) {
        entries.push({ text: item.title, url: markdownSourceUrl(overviewFile), description: item.description });
    }

    if (item.readme && item.readme !== item.overview) {
        const readme = path.resolve(repoRoot, `${item.readme.slice(1)}.md`);
        if (fs.existsSync(readme)) {
            entries.push({
                text: `${item.title} README`,
                url: markdownSourceUrl(readme),
                description: 'Additional component overview and usage details.',
            });
        }
    }

    for (const doc of item.customDocs) {
        if (doc.file === overviewFile) continue;
        entries.push({
            text: `${item.title}: ${doc.title}`,
            url: markdownSourceUrl(doc.file),
            description: descriptionOf(doc.file),
        });
    }

    return entries;
}

function llmsSection(title: string, entries: LlmsEntry[]): string {
    if (entries.length === 0) return '';
    const links = entries.map(({ text, url, description }) => {
        const label = text.replace(/[\\[\]]/g, '\\$&');
        const details = description?.trim() ? `: ${description.trim()}` : '';
        return `- [${label}](${url})${details}`;
    });
    return [`## ${title}`, '', ...links].join('\n');
}

function generateLlmsText(): string {
    const guideGroups = new Map<string, LlmsEntry[]>();
    for (const guide of guidePages) {
        const category = guide.category ?? 'Guides';
        const entries = guideGroups.get(category) ?? [];
        entries.push({ text: guide.text, url: markdownSourceUrl(guide.file), description: guide.description });
        guideGroups.set(category, entries);
    }
    const docsEntries: LlmsEntry[] = handwrittenDocs
        .filter(({ section }) => section === 'docs')
        .map((page) => ({
            text: page.title,
            url: markdownSourceUrl(page.file),
            description: page.description,
        }));

    const docsIndex: LlmsEntry = {
        text: 'Documentation index',
        url: markdownSourceUrl(path.join(repoRoot, 'docs/README.md')),
        description: 'Catalog of guides and documentation pages.',
    };
    const categories = [...guideGroups.entries()].sort(([left], [right]) => left.localeCompare(right));
    const gettingStarted = guideGroups.get('Getting started') ?? [];
    const sections = [
        llmsSection('Getting started', gettingStarted),
        ...categories
            .filter(([category]) => category !== 'Getting started')
            .map(([category, entries]) => llmsSection(category, entries)),
        llmsSection('Docs', [docsIndex, ...docsEntries]),
        llmsSection('Native plugins', native.flatMap(componentLlmsEntries)),
        llmsSection('Plugins', plugins.flatMap(componentLlmsEntries)),
        llmsSection('Shared tools', tools.flatMap(componentLlmsEntries)),
        llmsSection('GitHub Actions', actions.flatMap(componentLlmsEntries)),
        llmsSection('API reference', [
            ...apiNav.map(({ text, link }) => ({
                text: `${text} reference`,
                url: publishedPageUrl(link),
                description: 'Generated API and action contract documentation.',
            })),
            ...[...plugins, ...tools, ...actions, ...native]
                .filter((item) => item.apiReference)
                .map((item) => ({
                    text: `${item.title} API reference`,
                    url: publishedPageUrl(item.apiReference as string),
                    description: item.description,
                })),
        ]),
    ].filter(Boolean);
    const siteLink = publishedSiteUrl ?? siteBase;

    return [
        '# `pumpkin-plugins`',
        '',
        '> TypeScript plugins, shared tools, and GitHub Actions for Pumpkin Minecraft servers.',
        '',
        `Plugins are WebAssembly components that run in Pumpkin's Static Hermes/WASI runtime by default; QuickJS can be selected in the package's build configuration. Source links below return Markdown from the repository; generated API links point to the [documentation site](${siteLink}). This file is generated from discovered guides, component documentation, package metadata, and API references.`,
        '',
        sections.join('\n\n'),
        '',
    ].join('\n');
}

function card(item: Component): MenuCard {
    return {
        text: item.title,
        description: item.description,
        link: item.overview,
        ...(item.category ? { category: item.category } : {}),
        ...(item.icon ? { icon: item.icon } : {}),
        ...(item.menuItemType ? { type: item.menuItemType } : {}),
    };
}

function componentLinks(items: Component[], api = false): MenuCard[] {
    return items.flatMap((item) => {
        const link = api ? item.apiReference : item.overview;
        return link
            ? [
                  {
                      text: item.title,
                      description: item.description,
                      link,
                      ...(item.icon ? { icon: item.icon } : {}),
                      type: 'link',
                  },
              ]
            : [];
    });
}

function groupMenuItems(items: MenuCard[], defaultCategory: string): MenuSection[] {
    const groups = new Map<string, MenuCard[]>();
    for (const item of items) {
        const category = item.category ?? defaultCategory;
        const group = groups.get(category) ?? [];
        group.push(item);
        groups.set(category, group);
    }
    return [...groups.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([text, groupedItems]) => ({ text, items: groupedItems }));
}

function documentationMenuItem(node: DocumentationTreeNode): MenuItem {
    if (node.kind === 'page') {
        return {
            text: node.text,
            description: node.description,
            link: node.link,
            ...(node.type ? { type: node.type } : {}),
        };
    }
    return {
        text: node.text,
        ...(node.link ? { link: node.link } : {}),
        ...(node.description ? { description: node.description } : {}),
        items: node.items.map(documentationMenuItem),
    };
}

function documentationSidebarItem(node: DocumentationTreeNode, depth = 0): SidebarItem {
    if (node.kind === 'page') return { text: node.text, link: node.link };
    const items = node.items.map((child) => documentationSidebarItem(child, depth + 1));
    return {
        text: node.text,
        ...(node.link ? { link: node.link } : {}),
        ...(items.length ? { collapsed: depth > 0, items } : {}),
    };
}

function documentationNavItem(node: DocumentationTreeNode): DefaultTheme.NavItem {
    if (node.kind === 'page') return { text: node.text, link: node.link };
    return {
        text: node.text,
        ...(node.link ? { link: node.link } : {}),
        ...(node.items.length ? { items: node.items.map(documentationNavItem) } : {}),
    };
}

const docsMenuSections: MenuSection[] = docsTree.map((folder) => ({
    text: folder.text,
    ...(folder.link ? { link: folder.link } : {}),
    ...(folder.description ? { description: folder.description } : {}),
    items: folder.items.map(documentationMenuItem),
}));

function referenceItems(items: Component[]): DefaultTheme.SidebarItem[] {
    return items.flatMap((item) => (item.apiReference ? [{ text: item.title, link: item.apiReference }] : []));
}

type SidebarItem = DefaultTheme.SidebarItem;

function typedocSidebar(directory: string, depth = 0): SidebarItem[] {
    const sidebarPath = path.join(directory, 'typedoc-sidebar.json');
    if (!fs.existsSync(sidebarPath)) return [];
    const items = JSON.parse(fs.readFileSync(sidebarPath, 'utf8')) as SidebarItem[];
    return items.map((item) => ({
        ...item,
        ...(item.items ? { collapsed: depth > 0, items: collapseSidebar(item.items, depth + 1) } : {}),
    }));
}

function collapseSidebar(items: SidebarItem[], depth: number): SidebarItem[] {
    return items.map((item) => ({
        ...item,
        ...(item.items ? { collapsed: depth > 0, items: collapseSidebar(item.items, depth + 1) } : {}),
    }));
}

function componentSidebar(item: Component, siblings: Component[], groupName: string): SidebarItem[] {
    const pages = [
        { text: 'Overview', link: item.overview },
        ...(item.readme && item.readme !== item.overview ? [{ text: 'README', link: item.readme }] : []),
        ...item.customDocs
            .filter((doc) => !doc.file.endsWith('/index.md') && doc.route !== item.overview)
            .map(({ title, route }) => ({ text: title, link: route })),
        ...(item.apiReference ? [{ text: 'API reference', link: item.apiReference }] : []),
    ];
    const otherItems = siblings
        .filter((sibling) => sibling.slug !== item.slug)
        .map((sibling) => ({ text: sibling.title, link: sibling.overview }));
    return [
        { text: item.title, collapsed: false, items: pages },
        ...(otherItems.length ? [{ text: `Other ${groupName}`, collapsed: true, items: otherItems }] : []),
    ];
}

function documentationSidebar(item: Component, apiItems: SidebarItem[], extra: SidebarItem[] = []): SidebarItem[] {
    const docs = [
        { text: 'Component overview', link: item.overview },
        ...(item.readme && item.readme !== item.overview ? [{ text: 'README', link: item.readme }] : []),
        ...item.customDocs
            .filter((doc) => !doc.file.endsWith('/index.md') && doc.route !== item.overview)
            .map(({ title, route }) => ({ text: title, link: route })),
    ];
    return [
        { text: 'Component documentation', collapsed: false, items: docs },
        ...extra,
        ...(apiItems.length ? [{ text: 'API reference', collapsed: false, items: apiItems }] : []),
    ];
}

const apiSidebar = [
    { text: 'Plugins', link: '/api/plugins/', items: referenceItems(plugins) },
    { text: 'Tools', link: '/api/tools/', items: referenceItems(tools) },
    { text: 'Actions', link: '/api/actions/', items: referenceItems(actions) },
    { text: 'Scripts', link: '/api/scripts/', items: typedocSidebar(path.join(repoRoot, 'docs/api/scripts')) },
];

const apiNav = [
    { text: 'Overview', link: '/api/' },
    { text: 'Plugins', link: '/api/plugins/' },
    { text: 'Tools', link: '/api/tools/' },
    { text: 'Actions', link: '/api/actions/' },
    { text: 'Scripts', link: '/api/scripts/' },
] satisfies DefaultTheme.SidebarItem[];

const apiSidebars: Record<string, SidebarItem[]> = {
    '/api/': [{ text: 'Reference', link: '/api/', items: apiSidebar }],
    '/api/plugins/': [{ text: 'Plugins', link: '/api/plugins/', items: referenceItems(plugins) }],
    '/api/tools/': [{ text: 'Tools', link: '/api/tools/', items: referenceItems(tools) }],
    '/api/actions/': [{ text: 'Actions', link: '/api/actions/', items: referenceItems(actions) }],
    '/api/scripts/': typedocSidebar(path.join(repoRoot, 'docs/api/scripts')),
};

for (const item of [...plugins, ...tools]) {
    if (!item.apiReference) continue;
    const apiDirectory = path.join(repoRoot, 'docs', item.apiReference.slice(1));
    apiSidebars[item.apiReference] = documentationSidebar(item, typedocSidebar(apiDirectory));
}

for (const item of actions) {
    if (!item.apiReference) continue;
    const codeRoute = `${item.apiReference}code/`;
    const actionSections = [
        { text: 'Inputs', link: `${item.apiReference}#inputs` },
        { text: 'Outputs', link: `${item.apiReference}#outputs` },
        { text: 'Implementation reference', link: `${item.apiReference}#implementation-reference` },
        { text: 'JSDoc reference', link: codeRoute },
    ];
    apiSidebars[item.apiReference] = documentationSidebar(
        item,
        [],
        [{ text: 'Action reference', collapsed: false, items: actionSections }],
    );
    apiSidebars[codeRoute] = documentationSidebar(
        item,
        typedocSidebar(path.join(repoRoot, 'docs', item.apiReference.slice(1), 'code')),
        [{ text: 'Action contract', link: item.apiReference }],
    );
}

const scriptsSidebar = typedocSidebar(path.join(repoRoot, 'docs/api/scripts'));
if (scriptsSidebar.length) {
    apiSidebars['/api/scripts/'] = [
        { text: 'Reference', link: '/api/', items: apiNav },
        { text: 'Script helpers', collapsed: false, items: scriptsSidebar },
    ];
}

const featuredPlugin = plugins.find((item) => item.featured);
const megaMenus: MegaMenu[] = [
    {
        text: 'Plugins',
        description: 'Guides and references for plugins running on Pumpkin servers.',
        sections: groupMenuItems(
            plugins.map((item) => (item === featuredPlugin ? { ...card(item), type: 'link' } : card(item))),
            'Plugins',
        ),
        ...(featuredPlugin
            ? { featured: { ...card(featuredPlugin), type: featuredPlugin.menuItemType ?? 'card' } }
            : {}),
    },
    ...(native.length
        ? [
              {
                  text: 'Native plugins',
                  description: 'Native libraries for an exact Pumpkin host build.',
                  sections: groupMenuItems(native.map(card), 'Native plugins'),
              },
          ]
        : []),
    {
        text: 'Tools',
        description: 'Shared packages and utilities for building and maintaining plugins.',
        sections: groupMenuItems(tools.map(card), 'Tools'),
    },
    {
        text: 'Actions',
        description: 'Automate plugin publishing, signing, and Market updates with GitHub Actions.',
        sections: groupMenuItems(actions.map(card), 'Actions'),
    },
    {
        text: 'Guides',
        description: 'Practical setup help for server owners and step-by-step help for contributors.',
        sections: groupMenuItems(guidePages, 'Guides'),
    },
    {
        text: 'Docs',
        description: 'Technical documentation grouped by its folder structure.',
        hierarchical: true,
        sections: docsMenuSections,
    },
    {
        text: 'Reference',
        description: 'Browse the generated API and action contract references.',
        overview: { text: 'Reference overview', description: 'Browse all generated references.', link: '/api/' },
        sections: [
            { text: 'Plugin APIs', gridArea: 'plugin-apis', items: componentLinks(plugins, true) },
            { text: 'Tool APIs', gridArea: 'tool-apis', items: componentLinks(tools, true) },
            { text: 'Action references', gridArea: 'action-references', items: componentLinks(actions, true) },
            {
                text: 'Repository scripts',
                gridArea: 'repository-scripts',
                items: [
                    {
                        text: 'Script helpers',
                        description: 'Exported helpers used by repository automation.',
                        link: '/api/scripts/',
                    },
                ],
            },
        ],
    },
];

megaMenus.push({ text: 'Team', description: 'Meet the contributors.', link: '/team', sections: [] });

const mobileNav: DefaultTheme.NavItem[] = [
    { text: 'Plugins', items: plugins.map((item) => ({ text: item.title, link: item.overview })) },
    ...(native.length
        ? [{ text: 'Native plugins', items: native.map((item) => ({ text: item.title, link: item.overview })) }]
        : []),
    { text: 'Tools', items: tools.map((item) => ({ text: item.title, link: item.overview })) },
    { text: 'Actions', items: actions.map((item) => ({ text: item.title, link: item.overview })) },
    { text: 'Guides', items: guidePages.map(({ text, link }) => ({ text, link })) },
    { text: 'Docs', items: docsTree.map(documentationNavItem) },
    { text: 'Reference', items: apiNav },
    { text: 'Team', link: '/team' },
];

const componentSidebars: Record<string, SidebarItem[]> = {};
for (const item of plugins) componentSidebars[`/packages/${item.slug}/`] = componentSidebar(item, plugins, 'plugins');
for (const item of tools) componentSidebars[`/tools/${item.slug}/`] = componentSidebar(item, tools, 'tools');
for (const item of actions) componentSidebars[`/actions/${item.slug}/`] = componentSidebar(item, actions, 'actions');

for (const item of native)
    componentSidebars[`/native/${item.slug}/`] = componentSidebar(item, native, 'native plugins');

const guideSidebar: SidebarItem[] = [
    { text: 'Guides', collapsed: false, items: guidePages.map(({ text, link }) => ({ text, link })) },
    { text: 'Plugins', collapsed: true, items: plugins.map((item) => ({ text: item.title, link: item.overview })) },
    { text: 'Tools', collapsed: true, items: tools.map((item) => ({ text: item.title, link: item.overview })) },
    { text: 'Actions', collapsed: true, items: actions.map((item) => ({ text: item.title, link: item.overview })) },
    { text: 'API reference', link: '/api/' },
];

const typedApiMenus = {
    plugins: referenceItems(plugins),
    tools: referenceItems(tools),
    actions: referenceItems(actions),
};

const themeConfig = {
    nav: mobileNav,
    megaMenus,
    sidebar: {
        '/packages/': plugins.map((item) => ({ text: item.title, link: item.overview })),
        '/tools/': tools.map((item) => ({ text: item.title, link: item.overview })),
        '/actions/': actions.map((item) => ({ text: item.title, link: item.overview })),
        '/guides/': guideSidebar,
        '/docs/': docsTree.map((folder) => documentationSidebarItem(folder)),
        '/api/': [{ text: 'Reference', link: '/api/', items: apiSidebar }],
        '/api/plugins/': [{ text: 'Plugins', link: '/api/plugins/', items: typedApiMenus.plugins }],
        '/api/tools/': [{ text: 'Tools', link: '/api/tools/', items: typedApiMenus.tools }],
        '/api/actions/': [{ text: 'Actions', link: '/api/actions/', items: typedApiMenus.actions }],
        ...componentSidebars,
        ...apiSidebars,
    },
    editLink: {
        text: 'Edit this page on GitHub',
        pattern: ({ frontmatter }: { frontmatter: Record<string, unknown> }) => frontmatter.editLink as string,
    },
    lastUpdated: { text: 'Last updated' },
    search: { provider: 'local' as const },
    socialLinks: [{ icon: 'github' as const, link: repoUrl }],
    footer: {
        message: 'pumpkin-plugins documentation',
        copyright: 'MIT License',
    },
} satisfies ThemeConfigWithMegaMenus;

export default defineConfig({
    srcDir: '..',
    additionalConfig: {},
    markdown: {
        config(md) {
            // The standalone Team page lives in docs, but its public route is outside /guides/.
            md.core.ruler.push('team-page-links', (state) => {
                if (!/^(?:docs|guides)\//.test(state.env.relativePath)) return;
                for (const token of state.tokens.flatMap((block) => block.children ?? [])) {
                    if (token.type === 'link_open' && /^(?:\.\/)?team\.md(?:#.*)?$/.test(token.attrGet('href') ?? '')) {
                        token.attrSet('href', (token.attrGet('href') ?? '').replace(/^(?:\.\/)?team\.md/, '/team'));
                    }
                }
            });
            md.core.ruler.push('repository-doc-links', (state) => {
                const routePath = state.env.relativePath;
                const sourcePath = sourcePathsByRoute.get(routePath) ?? routePath;
                for (const token of state.tokens.flatMap((block) => block.children ?? [])) {
                    if (token.type !== 'link_open') continue;
                    const href = token.attrGet('href') ?? '';
                    const match = /^([^?#]*)([?#].*)?$/.exec(href);
                    if (!match?.[1] || /^[a-z][a-z\d+.-]*:/i.test(match[1]) || match[1].startsWith('/')) {
                        continue;
                    }
                    const target = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), match[1]));
                    const sourceTarget = path.posix.extname(target) ? target : `${target}.md`;
                    const route = rewrites[sourceTarget];
                    if (route) {
                        const routeWithoutExtension = route.replace(/\.md$/, '');
                        const publicRoute =
                            routeWithoutExtension === 'index'
                                ? '/'
                                : routeWithoutExtension.endsWith('/index')
                                  ? `/${routeWithoutExtension.slice(0, -'index'.length)}`
                                  : `/${routeWithoutExtension}`;
                        token.attrSet('href', `${publicRoute}${match[2] ?? ''}`);
                    }
                }
            });
            md.core.ruler.push('component-title-metadata', (state) => {
                const icon = componentLandingIcons.get(state.env.relativePath);
                const version = componentVersions.get(state.env.relativePath);
                if (!icon && !version) return;
                const heading = state.tokens.findIndex((token) => token.type === 'heading_open' && token.tag === 'h1');
                if (heading === -1) return;
                const inline = state.tokens[heading + 1];
                if (!inline.children) return;

                state.tokens[heading].attrJoin('class', 'component-page-title');
                const opening = new state.Token('html_inline', '', 0);
                const src = icon ? md.utils.escapeHtml(JSON.stringify(`${siteBase}${icon.slice(1)}`)) : undefined;
                opening.content = `${src ? `<img class="component-page-title__icon" :src="${src}" alt="" aria-hidden="true" width="48" height="48">` : ''}<span class="component-page-title__text">`;
                const closing = new state.Token('html_inline', '', 0);
                closing.content = '</span>';
                if (version) {
                    const text = md.utils.escapeHtml(`v${version.version}`);
                    const badge = `<Badge type="info" text="${text}" />`;
                    closing.content += version.release
                        ? `<a class="component-page-title__version" href="${md.utils.escapeHtml(version.release)}" aria-label="Release ${text}">${badge}</a>`
                        : `<span class="component-page-title__version">${badge}</span>`;
                }
                inline.children.unshift(opening);
                inline.children.push(closing);
            });
        },
    },
    vite: {
        plugins: [
            {
                name: 'component-navigation-assets-and-llms',
                buildStart() {
                    fs.writeFileSync(path.join(repoRoot, 'docs/llms.txt'), generateLlmsText());
                },
                configureServer(server) {
                    server.middlewares.use((request, response, next) => {
                        const requestPath = request.url?.split('?')[0];
                        if (requestPath !== '/llms.txt' && requestPath !== `${siteBase}llms.txt`) {
                            next();
                            return;
                        }
                        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
                        response.end(generateLlmsText());
                    });
                },
                generateBundle() {
                    const llmsText = generateLlmsText();
                    fs.writeFileSync(path.join(repoRoot, 'docs/llms.txt'), llmsText);
                    this.emitFile({ type: 'asset', fileName: 'llms.txt', source: llmsText });
                    for (const [fileName, file] of navigationAssets) {
                        this.emitFile({ type: 'asset', fileName, source: fs.readFileSync(file) });
                    }
                },
            },
        ],
    },
    transformPageData(pageData) {
        if (typeof pageData.frontmatter.editLink !== 'string') {
            pageData.frontmatter.editLink = `${repoUrl}/edit/master/${pageData.filePath}`;
        }
    },
    srcExclude: [
        '**/README.md',
        '**/CHANGELOG.md',
        '**/AGENTS.md',
        'plans/**',
        '.agents/**',
        '.github/**',
        '**/node_modules/**',
        'docs/.vitepress/**',
    ],
    rewrites,
    ignoreDeadLinks: [/README(?:\.md)?$/],
    head: [
        ['meta', { name: 'google-site-verification', content: 'Ac8kmcoez1w3jlR5BxcQ8mBc5f0gcZ4s40xNXad4804' }],
        ['link', { rel: 'describedby', href: `${siteBase}llms.txt` }],
    ],
    title: 'pumpkin-plugins',
    description: 'Guides and references for pumpkin-plugins, actions, and developer tools.',
    cleanUrls: true,
    base: siteBase,
    lastUpdated: true,
    themeConfig,
});
