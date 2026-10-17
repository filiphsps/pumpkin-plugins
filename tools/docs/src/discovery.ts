import { type Dirent, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/** Repository component kinds with package or GitHub Action metadata. */
export type ComponentGroup = 'packages' | 'tools' | 'actions' | 'extensions' | 'native';

/** A discovered component; callers decide whether they need source files, READMEs or other metadata. */
export interface SourceComponent {
    directory: string;
    metadataFile: string;
    slug: string;
}

/** Treat symlinked directories as directories while ignoring broken links. */
function isDirectoryEntry(directory: string, entry: Dirent): boolean {
    if (entry.isDirectory()) return true;
    if (!entry.isSymbolicLink()) return false;
    try {
        return statSync(join(directory, entry.name)).isDirectory();
    } catch {
        return false;
    }
}

/** Discover sorted component folders by metadata, including grouped tool packages. */
export function discoverComponents(root: string, group: ComponentGroup): SourceComponent[] {
    const base = resolve(root, group);
    if (!existsSync(base)) return [];
    const names =
        group === 'actions' ? ['action.yml', 'action.yaml'] : group === 'native' ? ['Cargo.toml'] : ['package.json'];
    const componentIn = (directory: string): SourceComponent | undefined => {
        const metadataFile = names.map((name) => join(directory, name)).find((file) => existsSync(file));
        return metadataFile
            ? { slug: relative(base, directory).split(sep).join('/'), directory, metadataFile }
            : undefined;
    };
    const folders = readdirSync(base, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith('_') && isDirectoryEntry(base, entry))
        .map((entry) => join(base, entry.name));
    return folders
        .flatMap((directory) => {
            const component = componentIn(directory);
            if (component || group !== 'tools') return component ? [component] : [];
            return readdirSync(directory, { withFileTypes: true })
                .filter((entry) => !entry.name.startsWith('_') && isDirectoryEntry(directory, entry))
                .map((entry) => componentIn(join(directory, entry.name)))
                .filter((nested): nested is SourceComponent => nested !== undefined);
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

/** Find a component-local license file, ignoring directories and accepting common case-insensitive names. */
export function localLicenseFile(directory: string): string | undefined {
    if (!existsSync(directory)) return undefined;
    const file = readdirSync(directory, { withFileTypes: true }).find(
        (entry) => entry.isFile() && /^license(?:\.md|\.txt)?$/i.test(entry.name),
    );
    return file ? join(directory, file.name) : undefined;
}
