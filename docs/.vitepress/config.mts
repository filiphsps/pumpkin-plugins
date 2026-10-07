import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { type DefaultTheme, defineConfig } from 'vitepress';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const siteBase = '/pumpkin-plugins/';
const repository = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).repository;
const repoUrl = (typeof repository === 'string' ? repository : repository.url)
    .replace(/^git\+/, '')
    .replace(/\.git$/, '');
const markdown = (file: string) => file.endsWith('.md');

function walkMarkdown(directory: string): string[] {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) return walkMarkdown(absolute);
        return markdown(entry.name) ? [absolute] : [];
    });
}

function folders(group: string, hasPackageJson = false): string[] {
    const directory = path.join(repoRoot, group);
    if (!fs.existsSync(directory)) return [];
    return fs
        .readdirSync(directory, { withFileTypes: true })
        .filter((entry) => {
            if (!entry.isDirectory() || entry.name.startsWith('_')) return false;
            const folder = path.join(directory, entry.name);
            return hasPackageJson
                ? fs.existsSync(path.join(folder, 'package.json'))
                : fs.existsSync(path.join(folder, 'action.yml')) || fs.existsSync(path.join(folder, 'action.yaml'));
        })
        .map((entry) => entry.name)
        .sort();
}

function titleOf(file: string, fallback: string): string {
    const heading = fs
        .readFileSync(file, 'utf8')
        .match(/^#\s+(.+)$/m)?.[1]
        ?.trim();
    const title = frontmatterOf(file).title;
    return heading?.replace(/\s+#*$/, '') || (typeof title === 'string' ? title : fallback);
}

const rewrites: Record<string, string> = {
    'docs/index.md': 'index.md',
    'docs/README.md': 'guides/index.md',
    'docs/team.md': 'team.md'
};
const navigationAssets = new Map<string, string>();

for (const file of walkMarkdown(path.join(repoRoot, 'docs'))) {
    const relative = path.relative(repoRoot, file).split(path.sep).join('/');
    if (relative in rewrites) continue;
    if (relative.startsWith('docs/api/')) {
        rewrites[relative] = relative.slice('docs/'.length);
        continue;
    }
    rewrites[relative] = `guides/${relative.slice('docs/'.length)}`;
}

interface Component {
    slug: string;
    title: string;
    description: string;
    overview: string;
    category?: string;
    icon?: string;
    menuItemType?: MenuCard['type'];
    readme?: string;
    apiReference?: string;
    featured: boolean;
    customDocs: { file: string; title: string; route: string }[];
}

interface MenuCard {
    text: string;
    description: string;
    link: string;
    category?: string;
    icon?: string;
    type?: 'link' | 'card' | 'spotlight';
}

interface MenuSection {
    text: string;
    items: MenuCard[];
    gridArea?: string;
}

interface MegaMenu {
    text: string;
    link?: string;
    description: string;
    overview?: MenuCard;
    sections: MenuSection[];
    featured?: MenuCard;
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
    const source = fs.readFileSync(file, 'utf8').replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '');
    const prose = source
        .replace(/^#\s+.+$/m, '')
        .split(/\n\s*\n/)
        .map((paragraph) => paragraph.trim())
        .find((paragraph) => paragraph && !paragraph.startsWith('#') && !paragraph.startsWith('- '));
    return (prose ?? '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[`*_>#]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180);
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

function components(group: string, hasPackageJson = false): Component[] {
    return folders(group, hasPackageJson).flatMap((slug) => {
        const source = path.join(repoRoot, group, slug);
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
        const manifest = hasPackageJson
            ? JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
            : undefined;
        const actionManifestFile = ['action.yml', 'action.yaml']
            .map((filename) => path.join(source, filename))
            .find((file) => fs.existsSync(file));
        const actionManifest =
            !hasPackageJson && actionManifestFile
                ? (parseYaml(fs.readFileSync(actionManifestFile, 'utf8')) as Record<string, unknown>)
                : undefined;
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
        const apiDirectory =
            group === 'packages'
                ? path.join(repoRoot, 'docs/api/plugins', slug)
                : group === 'tools'
                  ? path.join(repoRoot, 'docs/api/tools', manifest?.name ?? slug)
                  : path.join(repoRoot, 'docs/api/actions', slug);
        const apiReference = fs.existsSync(path.join(apiDirectory, 'index.md'))
            ? `/${path.relative(path.join(repoRoot, 'docs'), apiDirectory).split(path.sep).join('/')}/`
            : undefined;

        const customDocs = docs.map((file) => {
            const relative = path.relative(docsDirectory, file).split(path.sep).join('/');
            const route = `${group}/${slug}/docs/${relative}`;
            return {
                file,
                title: titleOf(file, path.basename(file, '.md')),
                route: `/${route.replace(/\.md$/, '')}`
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
                customDocs
            }
        ];
    });
}

const plugins = components('packages', true);
const tools = components('tools', true);
const actions = components('actions');
const componentLandingIcons = new Map(
    [...plugins, ...tools, ...actions].flatMap((item) =>
        item.icon ? [[`${item.overview.slice(1)}.md`, item.icon] as const] : []
    )
);
const releaseConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'release-please-config.json'), 'utf8'));
const releaseTags = new Set(
    execFileSync('git', ['tag', '--list'], { cwd: repoRoot, encoding: 'utf8' }).trim().split('\n')
);
const componentVersions = new Map<string, { version: string; release?: string }>();
for (const [group, items] of [
    ['packages', plugins],
    ['actions', actions]
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

const guidePages = walkMarkdown(path.join(repoRoot, 'docs'))
    .filter(
        (file) =>
            !file.startsWith(path.join(repoRoot, 'docs/api') + path.sep) &&
            !['README.md', 'index.md', 'team.md'].includes(path.basename(file))
    )
    .map((file) => {
        const relative = path.relative(path.join(repoRoot, 'docs'), file).split(path.sep).join('/');
        return {
            text: titleOf(file, path.basename(file, '.md')),
            description: descriptionOf(file),
            link: `/guides/${relative.replace(/\.md$/, '')}`,
            category: categoryOf(frontmatterOf(file)),
            type: menuItemTypeOf(frontmatterOf(file))
        };
    });

function card(item: Component): MenuCard {
    return {
        text: item.title,
        description: item.description,
        link: item.overview,
        ...(item.category ? { category: item.category } : {}),
        ...(item.icon ? { icon: item.icon } : {}),
        ...(item.menuItemType ? { type: item.menuItemType } : {})
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
                      type: 'link'
                  }
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

function referenceItems(items: Component[]): DefaultTheme.NavItemWithLink[] {
    return items.flatMap((item) => (item.apiReference ? [{ text: item.title, link: item.apiReference }] : []));
}

type SidebarItem = DefaultTheme.SidebarItem;

function typedocSidebar(directory: string, depth = 0): SidebarItem[] {
    const sidebarPath = path.join(directory, 'typedoc-sidebar.json');
    if (!fs.existsSync(sidebarPath)) return [];
    const items = JSON.parse(fs.readFileSync(sidebarPath, 'utf8')) as SidebarItem[];
    return items.map((item) => ({
        ...item,
        ...(item.items ? { collapsed: depth > 0, items: collapseSidebar(item.items, depth + 1) } : {})
    }));
}

function collapseSidebar(items: SidebarItem[], depth: number): SidebarItem[] {
    return items.map((item) => ({
        ...item,
        ...(item.items ? { collapsed: depth > 0, items: collapseSidebar(item.items, depth + 1) } : {})
    }));
}

function componentSidebar(item: Component, siblings: Component[], groupName: string): SidebarItem[] {
    const pages = [
        { text: 'Overview', link: item.overview },
        ...(item.readme && item.readme !== item.overview ? [{ text: 'README', link: item.readme }] : []),
        ...item.customDocs
            .filter((doc) => !doc.file.endsWith('/index.md') && doc.route !== item.overview)
            .map(({ title, route }) => ({ text: title, link: route })),
        ...(item.apiReference ? [{ text: 'API reference', link: item.apiReference }] : [])
    ];
    const otherItems = siblings
        .filter((sibling) => sibling.slug !== item.slug)
        .map((sibling) => ({ text: sibling.title, link: sibling.overview }));
    return [
        { text: item.title, collapsed: false, items: pages },
        ...(otherItems.length ? [{ text: `Other ${groupName}`, collapsed: true, items: otherItems }] : [])
    ];
}

function documentationSidebar(item: Component, apiItems: SidebarItem[], extra: SidebarItem[] = []): SidebarItem[] {
    const docs = [
        { text: 'Component overview', link: item.overview },
        ...(item.readme && item.readme !== item.overview ? [{ text: 'README', link: item.readme }] : []),
        ...item.customDocs
            .filter((doc) => !doc.file.endsWith('/index.md') && doc.route !== item.overview)
            .map(({ title, route }) => ({ text: title, link: route }))
    ];
    return [
        { text: 'Component documentation', collapsed: false, items: docs },
        ...extra,
        ...(apiItems.length ? [{ text: 'API reference', collapsed: false, items: apiItems }] : [])
    ];
}

const apiSidebar = [
    { text: 'Plugins', link: '/api/plugins/', items: referenceItems(plugins) },
    { text: 'Tools', link: '/api/tools/', items: referenceItems(tools) },
    { text: 'Actions', link: '/api/actions/', items: referenceItems(actions) },
    { text: 'Scripts', link: '/api/scripts/', items: typedocSidebar(path.join(repoRoot, 'docs/api/scripts')) }
];

const apiNav: DefaultTheme.NavItemWithLink[] = [
    { text: 'Overview', link: '/api/' },
    { text: 'Plugins', link: '/api/plugins/' },
    { text: 'Tools', link: '/api/tools/' },
    { text: 'Actions', link: '/api/actions/' },
    { text: 'Scripts', link: '/api/scripts/' }
];

const apiSidebars: Record<string, SidebarItem[]> = {
    '/api/': [{ text: 'Reference', link: '/api/', items: apiSidebar }],
    '/api/plugins/': [{ text: 'Plugins', link: '/api/plugins/', items: referenceItems(plugins) }],
    '/api/tools/': [{ text: 'Tools', link: '/api/tools/', items: referenceItems(tools) }],
    '/api/actions/': [{ text: 'Actions', link: '/api/actions/', items: referenceItems(actions) }],
    '/api/scripts/': typedocSidebar(path.join(repoRoot, 'docs/api/scripts'))
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
        { text: 'JSDoc reference', link: codeRoute }
    ];
    apiSidebars[item.apiReference] = documentationSidebar(
        item,
        [],
        [{ text: 'Action reference', collapsed: false, items: actionSections }]
    );
    apiSidebars[codeRoute] = documentationSidebar(
        item,
        typedocSidebar(path.join(repoRoot, 'docs', item.apiReference.slice(1), 'code')),
        [{ text: 'Action contract', link: item.apiReference }]
    );
}

const scriptsSidebar = typedocSidebar(path.join(repoRoot, 'docs/api/scripts'));
if (scriptsSidebar.length) {
    apiSidebars['/api/scripts/'] = [
        { text: 'Reference', link: '/api/', items: apiNav },
        { text: 'Script helpers', collapsed: false, items: scriptsSidebar }
    ];
}

const featuredPlugin = plugins.find((item) => item.featured);
const megaMenus: MegaMenu[] = [
    {
        text: 'Plugins',
        description: 'Guides and references for plugins running on Pumpkin servers.',
        sections: groupMenuItems(
            plugins.map((item) => (item === featuredPlugin ? { ...card(item), type: 'link' } : card(item))),
            'Plugins'
        ),
        ...(featuredPlugin
            ? { featured: { ...card(featuredPlugin), type: featuredPlugin.menuItemType ?? 'card' } }
            : {})
    },
    {
        text: 'Tools',
        description: 'Shared packages and utilities for building and maintaining plugins.',
        sections: groupMenuItems(tools.map(card), 'Tools')
    },
    {
        text: 'Actions',
        description: 'Automate plugin publishing, signing, and Market updates with GitHub Actions.',
        sections: groupMenuItems(actions.map(card), 'Actions')
    },
    {
        text: 'Guides',
        description: 'Practical setup help for server owners and step-by-step help for contributors.',
        sections: groupMenuItems(guidePages, 'Guides')
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
                        link: '/api/scripts/'
                    }
                ]
            }
        ]
    }
];

megaMenus.push({ text: 'Team', description: 'Meet the contributors.', link: '/team', sections: [] });

const mobileNav: DefaultTheme.NavItem[] = [
    { text: 'Plugins', items: plugins.map((item) => ({ text: item.title, link: item.overview })) },
    { text: 'Tools', items: tools.map((item) => ({ text: item.title, link: item.overview })) },
    { text: 'Actions', items: actions.map((item) => ({ text: item.title, link: item.overview })) },
    { text: 'Guides', items: guidePages.map(({ text, link }) => ({ text, link })) },
    { text: 'Reference', items: apiNav },
    { text: 'Team', link: '/team' }
];

const componentSidebars: Record<string, SidebarItem[]> = {};
for (const item of plugins) componentSidebars[`/packages/${item.slug}/`] = componentSidebar(item, plugins, 'plugins');
for (const item of tools) componentSidebars[`/tools/${item.slug}/`] = componentSidebar(item, tools, 'tools');
for (const item of actions) componentSidebars[`/actions/${item.slug}/`] = componentSidebar(item, actions, 'actions');

const guideSidebar: SidebarItem[] = [
    { text: 'Guides', collapsed: false, items: guidePages.map(({ text, link }) => ({ text, link })) },
    { text: 'Plugins', collapsed: true, items: plugins.map((item) => ({ text: item.title, link: item.overview })) },
    { text: 'Tools', collapsed: true, items: tools.map((item) => ({ text: item.title, link: item.overview })) },
    { text: 'Actions', collapsed: true, items: actions.map((item) => ({ text: item.title, link: item.overview })) },
    { text: 'API reference', link: '/api/' }
];

const typedApiMenus = {
    plugins: referenceItems(plugins),
    tools: referenceItems(tools),
    actions: referenceItems(actions)
};

const themeConfig = {
    nav: mobileNav,
    megaMenus,
    sidebar: {
        '/packages/': plugins.map((item) => ({ text: item.title, link: item.overview })),
        '/tools/': tools.map((item) => ({ text: item.title, link: item.overview })),
        '/actions/': actions.map((item) => ({ text: item.title, link: item.overview })),
        '/guides/': guideSidebar,
        '/api/': [{ text: 'Reference', link: '/api/', items: apiSidebar }],
        '/api/plugins/': [{ text: 'Plugins', link: '/api/plugins/', items: typedApiMenus.plugins }],
        '/api/tools/': [{ text: 'Tools', link: '/api/tools/', items: typedApiMenus.tools }],
        '/api/actions/': [{ text: 'Actions', link: '/api/actions/', items: typedApiMenus.actions }],
        ...componentSidebars,
        ...apiSidebars
    },
    editLink: {
        text: 'Edit this page on GitHub',
        pattern: ({ frontmatter }: { frontmatter: Record<string, unknown> }) => frontmatter.editLink as string
    },
    lastUpdated: { text: 'Last updated' },
    search: { provider: 'local' as const },
    socialLinks: [{ icon: 'github' as const, link: repoUrl }],
    footer: {
        message: 'Pumpkin Plugins documentation',
        copyright: 'MIT License'
    }
} satisfies DefaultTheme.Config & { megaMenus: MegaMenu[] };

export default defineConfig({
    srcDir: '..',
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
        }
    },
    vite: {
        plugins: [
            {
                name: 'component-navigation-assets',
                generateBundle() {
                    for (const [fileName, file] of navigationAssets) {
                        this.emitFile({ type: 'asset', fileName, source: fs.readFileSync(file) });
                    }
                }
            }
        ]
    },
    transformPageData(pageData) {
        if (typeof pageData.frontmatter.editLink !== 'string') {
            pageData.frontmatter.editLink = `${repoUrl}/edit/master/${pageData.filePath}`;
        }
    },
    srcExclude: [
        'README.md',
        '**/CHANGELOG.md',
        '**/AGENTS.md',
        '.agents/**',
        '.github/**',
        '**/node_modules/**',
        'docs/.vitepress/**'
    ],
    rewrites,
    ignoreDeadLinks: [/README(?:\.md)?$/],
    head: [['meta', { name: 'google-site-verification', content: 'Ac8kmcoez1w3jlR5BxcQ8mBc5f0gcZ4s40xNXad4804' }]],
    title: 'Pumpkin Plugins',
    description: 'Guides and references for Pumpkin plugins, actions, and developer tools.',
    cleanUrls: true,
    base: siteBase,
    lastUpdated: true,
    themeConfig
});
