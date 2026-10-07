import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitepress';

const repoRoot = path.resolve(import.meta.dirname, '../..');
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
    rewrites[relative] = `guides/${relative.slice('docs/'.length)}`;
}

interface Component {
    slug: string;
    title: string;
    overview: string;
    readme?: string;
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
        const fallbackTitle = hasPackageJson
            ? JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).name
            : slug;
        const title = headingSource ? titleOf(headingSource, fallbackTitle) : fallbackTitle;
        const readmeRoute = fs.existsSync(readme) ? `/${group}/${slug}/README` : undefined;

        const customDocs = docs.map((file) => {
            const relative = path.relative(docsDirectory, file).split(path.sep).join('/');
            const route = `${group}/${slug}/docs/${relative}`;
            return {
                file,
                title: titleOf(file, path.basename(file, '.md')),
                route: `/${route.replace(/\.md$/, '')}`
            };
        });

        return [{ slug, title, overview, readme: readmeRoute, customDocs }];
    });
}

const plugins = components('packages', true);
const tools = components('tools', true);
const actions = components('actions');

const guideItems = walkMarkdown(path.join(repoRoot, 'docs'))
    .filter((file) => !['README.md', 'index.md'].includes(path.basename(file)))
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
                .map(({ title, route }) => ({ text: title, link: route }))
        ]
    }));
}

const apiSidebarPath = path.join(repoRoot, 'api/tools/typedoc-sidebar.json');
const apiSidebar = fs.existsSync(apiSidebarPath) ? JSON.parse(fs.readFileSync(apiSidebarPath, 'utf8')) : [];

export default defineConfig({
    srcDir: '..',
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
            { text: 'API', link: '/api/tools/' }
        ],
        sidebar: {
            '/packages/': componentItems(plugins),
            '/tools/': componentItems(tools),
            '/actions/': componentItems(actions),
            '/guides/': [{ text: 'Guides', items: guideItems }],
            '/api/': [{ text: 'Tools API', items: apiSidebar }]
        },
        search: { provider: 'local' },
        socialLinks: [{ icon: 'github', link: 'https://github.com/filiphsps/pumpkin-plugins' }],
        footer: {
            message: 'Pumpkin Plugins documentation',
            copyright: 'MIT License'
        }
    }
});
