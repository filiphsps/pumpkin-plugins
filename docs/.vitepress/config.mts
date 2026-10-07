import fs from 'node:fs';
import path from 'node:path';
import { type DefaultTheme, defineConfig } from 'vitepress';

const repoRoot = path.resolve(import.meta.dirname, '../..');
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
    return heading?.replace(/\s+#*$/, '') || fallback;
}

const rewrites: Record<string, string> = {
    'docs/index.md': 'index.md',
    'docs/README.md': 'guides/index.md'
};

for (const file of walkMarkdown(path.join(repoRoot, 'docs'))) {
    const relative = path.relative(repoRoot, file).split(path.sep).join('/');
    if (relative === 'docs/index.md' || relative === 'docs/README.md') continue;
    if (relative.startsWith('docs/api/')) {
        rewrites[relative] = relative.slice('docs/'.length);
        continue;
    }
    rewrites[relative] = `guides/${relative.slice('docs/'.length)}`;
}

interface Component {
    slug: string;
    title: string;
    overview: string;
    readme?: string;
    apiReference?: string;
    customDocs: { file: string; title: string; route: string }[];
}

function components(group: string, hasPackageJson = false): Component[] {
    return folders(group, hasPackageJson).flatMap((slug) => {
        const source = path.join(repoRoot, group, slug);
        const readme = path.join(source, 'README.md');
        const docsDirectory = path.join(source, 'docs');
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
        const fallbackTitle = manifest?.name ?? slug;
        const title = headingSource ? titleOf(headingSource, fallbackTitle) : fallbackTitle;
        const readmeRoute = fs.existsSync(readme) ? `/${group}/${slug}/README` : undefined;
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

        return [{ slug, title, overview, readme: readmeRoute, apiReference, customDocs }];
    });
}

const plugins = components('packages', true);
const tools = components('tools', true);
const actions = components('actions');

const guideItems = walkMarkdown(path.join(repoRoot, 'docs'))
    .filter(
        (file) =>
            !file.startsWith(path.join(repoRoot, 'docs/api') + path.sep) &&
            !['README.md', 'index.md'].includes(path.basename(file))
    )
    .map((file) => {
        const relative = path.relative(path.join(repoRoot, 'docs'), file).split(path.sep).join('/');
        return {
            text: titleOf(file, path.basename(file, '.md')),
            link: `/guides/${relative.replace(/\.md$/, '')}`
        };
    });

function componentItems(items: Component[]) {
    return items.map((item) => ({
        text: item.title,
        link: item.overview,
        items: [
            { text: 'Overview', link: item.overview },
            ...(item.readme && item.readme !== item.overview ? [{ text: 'README', link: item.readme }] : []),
            ...item.customDocs
                .filter((doc) => !doc.file.endsWith('/index.md') && doc.route !== item.overview)
                .map(({ title, route }) => ({ text: title, link: route })),
            ...(item.apiReference ? [{ text: 'API Reference', link: item.apiReference }] : [])
        ]
    }));
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

const componentSidebars: Record<string, SidebarItem[]> = {};
for (const item of plugins) componentSidebars[`/packages/${item.slug}/`] = componentSidebar(item, plugins, 'plugins');
for (const item of tools) componentSidebars[`/tools/${item.slug}/`] = componentSidebar(item, tools, 'tools');
for (const item of actions) componentSidebars[`/actions/${item.slug}/`] = componentSidebar(item, actions, 'actions');

const guideSidebar: SidebarItem[] = [
    { text: 'Guides', collapsed: false, items: guideItems.map(({ text, link }) => ({ text, link })) },
    { text: 'Plugins', collapsed: true, items: plugins.map((item) => ({ text: item.title, link: item.overview })) },
    { text: 'Tools', collapsed: true, items: tools.map((item) => ({ text: item.title, link: item.overview })) },
    { text: 'Actions', collapsed: true, items: actions.map((item) => ({ text: item.title, link: item.overview })) },
    { text: 'API reference', link: '/api/' }
];

export default defineConfig({
    srcDir: '..',
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
    title: 'Pumpkin Plugins',
    description: 'Guides and references for Pumpkin plugins, actions, and developer tools.',
    cleanUrls: true,
    base: '/pumpkin-plugins/',
    themeConfig: {
        nav: [
            { text: 'Plugins', items: componentItems(plugins) },
            { text: 'Tools', items: componentItems(tools) },
            { text: 'Actions', items: componentItems(actions) },
            { text: 'Guides', link: '/guides/' },
            { text: 'Reference', items: apiNav }
        ],
        sidebar: {
            '/packages/': plugins.map((item) => ({ text: item.title, link: item.overview })),
            '/tools/': tools.map((item) => ({ text: item.title, link: item.overview })),
            '/actions/': actions.map((item) => ({ text: item.title, link: item.overview })),
            '/guides/': guideSidebar,
            '/api/': [{ text: 'Reference', link: '/api/', items: apiSidebar }],
            '/api/plugins/': [{ text: 'Plugins', link: '/api/plugins/', items: referenceItems(plugins) }],
            '/api/tools/': [{ text: 'Tools', link: '/api/tools/', items: referenceItems(tools) }],
            '/api/actions/': [{ text: 'Actions', link: '/api/actions/', items: referenceItems(actions) }],
            ...componentSidebars,
            ...apiSidebars
        },
        editLink: {
            text: 'Edit this page on GitHub',
            pattern: ({ frontmatter }) => frontmatter.editLink
        },
        search: { provider: 'local' },
        socialLinks: [{ icon: 'github', link: repoUrl }],
        footer: {
            message: 'Pumpkin Plugins documentation',
            copyright: 'MIT License'
        }
    }
});
