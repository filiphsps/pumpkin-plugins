import fs from 'node:fs';
import path from 'node:path';
import {
    type ComponentGroup,
    componentApiRoute,
    descriptionOf,
    discoverComponents,
    frontmatterOf,
    readActionMetadata,
    titleOf,
    walkMarkdown,
} from '@pumpkin-plugins/docs/node';
import { parse as parseYaml } from 'yaml';
import type { MenuCard } from './theme/types.ts';

/** A plugin, tool, action or extension as the site menus, sidebars and llms.txt see it. */
export interface Component {
    apiReference?: string;
    category?: string;
    customDocs: { file: string; title: string; route: string }[];
    description: string;
    featured: boolean;
    icon?: string;
    /** Absolute path of the icon file, which the build copies to the `icon` route. */
    iconFile?: string;
    menuItemType?: MenuCard['type'];
    overview: string;
    readme?: string;
    slug: string;
    title: string;
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

/** Reads one component group from the repository layout, its docs folders and `docs.yml` files. */
export function components(repoRoot: string, group: ComponentGroup): Component[] {
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
        const manifest = group !== 'actions' ? JSON.parse(fs.readFileSync(metadataFile, 'utf8')) : undefined;
        const actionManifest = group === 'actions' ? readActionMetadata(metadataFile) : undefined;
        const fallbackTitle = manifest?.name ?? slug;
        const title = headingSource ? titleOf(headingSource, fallbackTitle) : fallbackTitle;
        const description =
            manifest?.description ?? actionManifest?.description ?? (headingSource ? descriptionOf(headingSource) : '');
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
                iconFile,
                menuItemType,
                readme: readmeRoute,
                apiReference,
                featured,
                customDocs,
            },
        ];
    });
}
