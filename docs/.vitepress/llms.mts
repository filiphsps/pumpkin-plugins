import fs from 'node:fs';
import path from 'node:path';
import { descriptionOf, type HandwrittenDocPage } from '@pumpkin-plugins/docs/node';
import type { Component } from './components.mts';

/** What the site config discovered, as `generateLlmsText` needs it. */
export interface LlmsSite {
    actions: Component[];
    apiNav: { link: string; text: string }[];
    extensions: Component[];
    handwrittenDocs: HandwrittenDocPage[];
    plugins: Component[];
    repoRoot: string;
    repoUrl: string;
    siteUrl?: URL;
    tools: Component[];
}

interface LlmsEntry {
    description?: string;
    text: string;
    url: string;
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

/** Builds `/llms.txt`: guides and component docs link to raw Markdown, API pages to the published site. */
export function generateLlmsText(site: LlmsSite): string {
    const { repoRoot, repoUrl, plugins, tools, actions, extensions } = site;
    const githubRepository = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(repoUrl)?.[1];
    const rawRepositoryUrl = githubRepository
        ? `https://raw.githubusercontent.com/${githubRepository}/master`
        : undefined;
    const publishedSiteUrl = site.siteUrl?.href;
    const siteBase = site.siteUrl?.pathname ?? '/';

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

    const guideGroups = new Map<string, LlmsEntry[]>();
    for (const guide of site.handwrittenDocs.filter(({ section }) => section === 'guides')) {
        const category = guide.category ?? 'Guides';
        const entries = guideGroups.get(category) ?? [];
        entries.push({ text: guide.title, url: markdownSourceUrl(guide.file), description: guide.description });
        guideGroups.set(category, entries);
    }
    const docsEntries: LlmsEntry[] = site.handwrittenDocs
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
        llmsSection('Plugins', plugins.flatMap(componentLlmsEntries)),
        llmsSection('Shared tools', tools.flatMap(componentLlmsEntries)),
        llmsSection('GitHub Actions', actions.flatMap(componentLlmsEntries)),
        llmsSection('VS Code extensions', extensions.flatMap(componentLlmsEntries)),
        llmsSection('API reference', [
            ...site.apiNav.map(({ text, link }) => ({
                text: `${text} reference`,
                url: publishedPageUrl(link),
                description: 'Generated API and action contract documentation.',
            })),
            ...[...plugins, ...tools, ...actions, ...extensions]
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
        `Plugins are WebAssembly components that Pumpkin loads through its WASI host; each component embeds Static Hermes by default, or QuickJS when the package selects it. Source links below return Markdown from the repository; generated API links point to the [documentation site](${siteLink}). This file is generated from discovered guides, component documentation, package metadata, and API references.`,
        '',
        sections.join('\n\n'),
        '',
    ].join('\n');
}
