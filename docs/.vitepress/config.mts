import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
    buildDocumentationTree,
    type DocumentationTreeNode,
    discoverHandwrittenDocs,
    githubPagesUrl,
    githubRepositoryUrl,
    rootPageRewrites,
    walkMarkdown,
} from '@pumpkin-plugins/docs/node';
import { type DefaultTheme, defineConfig } from 'vitepress';
import { type Component, components } from './components.mts';
import { generateLlmsText as renderLlmsText } from './llms.mts';
import type { MegaMenu, MenuCard, MenuItem, MenuSection, ThemeConfigWithMegaMenus } from './theme/types.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const repository = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).repository;
const repoUrl = githubRepositoryUrl(repository)?.href;
if (!repoUrl) throw new Error('Root package.json needs a GitHub repository URL');
const siteUrl = githubPagesUrl(repository);
const siteBase = siteUrl?.pathname ?? '/';

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

const plugins = components(repoRoot, 'packages');
const tools = components(repoRoot, 'tools');
const actions = components(repoRoot, 'actions');
const extensions = components(repoRoot, 'extensions');
for (const item of [...plugins, ...tools, ...actions, ...extensions]) {
    if (item.icon && item.iconFile) navigationAssets.set(item.icon.slice(1), item.iconFile);
    // Component READMEs keep their path; listing them lets links from rewritten guides resolve.
    if (item.readme) rewrites[`${item.readme.slice(1)}.md`] = `${item.readme.slice(1)}.md`;
}
const componentLandingIcons = new Map(
    [...plugins, ...tools, ...actions, ...extensions].flatMap((item) =>
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
] as const) {
    for (const item of items) {
        const directory = `${group}/${item.slug}`;
        const versionFile = path.join(repoRoot, directory, group === 'packages' ? 'package.json' : 'version.txt');
        if (!fs.existsSync(versionFile)) continue;
        const source = fs.readFileSync(versionFile, 'utf8');
        const version: string = group === 'packages' ? JSON.parse(source).version : source.trim();
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

const scriptsSidebar = typedocSidebar(path.join(repoRoot, 'docs/api/scripts'));
const apiSidebar = [
    { text: 'Plugins', link: '/api/plugins/', items: referenceItems(plugins) },
    { text: 'Tools', link: '/api/tools/', items: referenceItems(tools) },
    { text: 'Actions', link: '/api/actions/', items: referenceItems(actions) },
    { text: 'Extensions', link: '/api/extensions/', items: referenceItems(extensions) },
    { text: 'Scripts', link: '/api/scripts/', items: scriptsSidebar },
];

const apiNav = [
    { text: 'Overview', link: '/api/' },
    { text: 'Plugins', link: '/api/plugins/' },
    { text: 'Tools', link: '/api/tools/' },
    { text: 'Actions', link: '/api/actions/' },
    { text: 'Extensions', link: '/api/extensions/' },
    { text: 'Scripts', link: '/api/scripts/' },
] satisfies DefaultTheme.SidebarItem[];

const apiSidebars: Record<string, SidebarItem[]> = {
    '/api/': [{ text: 'Reference', link: '/api/', items: apiSidebar }],
    '/api/plugins/': [{ text: 'Plugins', link: '/api/plugins/', items: referenceItems(plugins) }],
    '/api/tools/': [{ text: 'Tools', link: '/api/tools/', items: referenceItems(tools) }],
    '/api/actions/': [{ text: 'Actions', link: '/api/actions/', items: referenceItems(actions) }],
    '/api/extensions/': [{ text: 'Extensions', link: '/api/extensions/', items: referenceItems(extensions) }],
    '/api/scripts/': scriptsSidebar.length
        ? [
              { text: 'Reference', link: '/api/', items: apiNav },
              { text: 'Script helpers', collapsed: false, items: scriptsSidebar },
          ]
        : [],
};

for (const item of [...plugins, ...tools, ...extensions]) {
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

const generateLlmsText = () =>
    renderLlmsText({ repoRoot, repoUrl, siteUrl, handwrittenDocs, apiNav, plugins, tools, actions, extensions });

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
    {
        text: 'Tools',
        description: 'Shared packages, utilities, and editor extensions for building and maintaining plugins.',
        sections: groupMenuItems(
            [...tools.map(card), ...extensions.map((item) => ({ category: 'VS Code extensions', ...card(item) }))],
            'Tools',
        ),
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
            { text: 'Extension APIs', gridArea: 'extension-apis', items: componentLinks(extensions, true) },
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

const componentSidebars: Record<string, SidebarItem[]> = {};
for (const item of plugins) componentSidebars[`/packages/${item.slug}/`] = componentSidebar(item, plugins, 'plugins');
for (const item of tools) componentSidebars[`/tools/${item.slug}/`] = componentSidebar(item, tools, 'tools');
for (const item of actions) componentSidebars[`/actions/${item.slug}/`] = componentSidebar(item, actions, 'actions');
for (const item of extensions) {
    componentSidebars[`/extensions/${item.slug}/`] = componentSidebar(item, extensions, 'extensions');
}

const guideSidebar: SidebarItem[] = [
    { text: 'Guides', collapsed: false, items: guidePages.map(({ text, link }) => ({ text, link })) },
    { text: 'Plugins', collapsed: true, items: plugins.map((item) => ({ text: item.title, link: item.overview })) },
    { text: 'Tools', collapsed: true, items: tools.map((item) => ({ text: item.title, link: item.overview })) },
    { text: 'Actions', collapsed: true, items: actions.map((item) => ({ text: item.title, link: item.overview })) },
    {
        text: 'Extensions',
        collapsed: true,
        items: extensions.map((item) => ({ text: item.title, link: item.overview })),
    },
    { text: 'API reference', link: '/api/' },
];

const themeConfig = {
    megaMenus,
    sidebar: {
        '/packages/': plugins.map((item) => ({ text: item.title, link: item.overview })),
        '/tools/': tools.map((item) => ({ text: item.title, link: item.overview })),
        '/actions/': actions.map((item) => ({ text: item.title, link: item.overview })),
        '/extensions/': extensions.map((item) => ({ text: item.title, link: item.overview })),
        '/guides/': guideSidebar,
        '/docs/': docsTree.map((folder) => documentationSidebarItem(folder)),
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
                        continue;
                    }
                    // The site publishes only Markdown, so other repository files and folders open on GitHub.
                    // Missing files and unpublished pages stay relative for the dead-link check.
                    const file = path.join(repoRoot, target);
                    if (target.startsWith('..') || target.endsWith('.md') || !fs.existsSync(file)) continue;
                    if (fs.existsSync(path.join(file, 'index.md'))) continue;
                    const view = fs.statSync(file).isDirectory() ? 'tree' : 'blob';
                    token.attrSet('href', `${repoUrl}/${view}/master/${target.replace(/\/$/, '')}${match[2] ?? ''}`);
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
                    this.emitFile({ type: 'asset', fileName: 'llms.txt', source: generateLlmsText() });
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
        'README.md',
        'benchmarks/**',
        'tools/create-pumpkin-plugin/templates/**',
        '**/CHANGELOG.md',
        '**/AGENTS.md',
        '.agents/**',
        'docs/agents/**',
        '.github/**',
        '**/node_modules/**',
        'docs/.vitepress/**',
    ],
    rewrites,
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
