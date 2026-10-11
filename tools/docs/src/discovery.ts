import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Repository component kinds with package or GitHub Action metadata. */
export type ComponentGroup = 'packages' | 'tools' | 'actions';

/** A discovered component; callers decide whether they need source files, READMEs or other metadata. */
export interface SourceComponent {
    slug: string;
    directory: string;
    metadataFile: string;
}

/** Discover sorted component folders by metadata, skipping underscore-prefixed scratch folders. */
export function discoverComponents(root: string, group: ComponentGroup): SourceComponent[] {
    const base = resolve(root, group);
    if (!existsSync(base)) return [];
    const names = group === 'actions' ? ['action.yml', 'action.yaml'] : ['package.json'];
    return readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
        .flatMap((entry) => {
            const directory = join(base, entry.name);
            const metadataFile = names.map((name) => join(directory, name)).find((file) => existsSync(file));
            return metadataFile ? [{ slug: entry.name, directory, metadataFile }] : [];
        })
        .sort((left, right) => left.slug.localeCompare(right.slug));
}

/** Find sorted Markdown files recursively, skipping node_modules, Git data and explicitly excluded paths. */
export function walkMarkdown(directory: string, options: { exclude?: readonly string[] } = {}): string[] {
    const excluded = new Set((options.exclude ?? []).map((file) => resolve(file)));
    function walk(folder: string): string[] {
        if (excluded.has(folder) || !existsSync(folder)) return [];
        return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
            const file = join(folder, entry.name);
            if (excluded.has(file) || entry.name === 'node_modules' || entry.name === '.git') return [];
            if (entry.isDirectory()) return walk(file);
            return entry.isFile() && file.endsWith('.md') ? [file] : [];
        });
    }
    return walk(resolve(directory)).sort();
}
