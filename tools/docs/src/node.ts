import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyBlocks } from './blocks.ts';
import type { PluginInfo } from './info.ts';
import { type PackageRow, ROOT_NOTE, renderPackagesBlock } from './packages.ts';
import { renderBlocks } from './sections.ts';

/** What happened to a README. `stale` is only reported when checking: nothing was written. */
export type Status = 'updated' | 'unchanged' | 'stale';

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

function infoPath(pluginDir: string): string {
    const pkg = readJson(path.join(pluginDir, 'package.json'));
    return path.resolve(pluginDir, pkg.pumpkinPlugin?.info ?? 'src/info.ts');
}

/**
 * Loads the `info` export of a plugin's info module. Node strips the TypeScript types.
 * @param pluginDir - The plugin's folder.
 * @returns What the plugin says about itself.
 * @throws {Error} When the module is missing or doesn't export a usable `info`.
 */
export async function loadInfo(pluginDir: string): Promise<PluginInfo> {
    const file = infoPath(pluginDir);
    if (!fs.existsSync(file)) {
        throw new Error(`${file} not found: a plugin needs a src/info.ts that exports \`info\``);
    }
    const mod = await import(pathToFileURL(file).href);
    const info = mod.info ?? mod.default;
    if (typeof info?.name !== 'string' || typeof info?.description !== 'string') {
        throw new Error(`${file} must export an \`info\` object with a name and a description`);
    }
    return info;
}

function readReadme(file: string, hint: string): string {
    if (!fs.existsSync(file)) throw new Error(`${file} not found. ${hint}`);
    return fs.readFileSync(file, 'utf8');
}

function write(file: string, existing: string, next: string, check: boolean): Status {
    if (existing === next) return 'unchanged';
    if (check) return 'stale';
    fs.writeFileSync(file, next);
    return 'updated';
}

/**
 * Refreshes the generated blocks of a plugin's README. Everything outside the blocks is kept.
 * @param pluginDir - The plugin's folder.
 * @param check - Only report whether the README is out of date, without writing.
 * @returns What happened to the README.
 * @throws {Error} When the README doesn't exist. `pnpm gen` creates one for new plugins.
 */
export async function generatePluginReadme(pluginDir: string, check = false): Promise<Status> {
    const info = await loadInfo(pluginDir);
    const file = path.join(pluginDir, 'README.md');
    const existing = readReadme(
        file,
        'Create it with <!-- docs:begin NAME --> blocks, as `pnpm gen` does for a new plugin.'
    );
    return write(file, existing, applyBlocks(existing, renderBlocks(info), file), check);
}

async function rows(root: string, group: 'packages' | 'tools'): Promise<PackageRow[]> {
    const base = path.join(root, group);
    if (!fs.existsSync(base)) return [];
    const out: PackageRow[] = [];
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        const dir = path.join(base, entry.name);
        if (!entry.isDirectory() || !fs.existsSync(path.join(dir, 'package.json'))) continue;
        const pkg = readJson(path.join(dir, 'package.json'));
        // Plugins are shown by their Pumpkin name and description when they define them.
        const info = group === 'packages' && fs.existsSync(infoPath(dir)) ? await loadInfo(dir) : undefined;
        out.push({
            dir: `${group}/${entry.name}`,
            name: info?.name ?? pkg.name,
            description: info?.description ?? pkg.description ?? ''
        });
    }
    return out;
}

/**
 * Refreshes the package tables in the repo's root README.
 * @param root - The repository root.
 * @param check - Only report whether the README is out of date, without writing.
 * @returns What happened to the README.
 * @throws {Error} When the README or its `packages` block is missing.
 */
export async function generateRootReadme(root: string, check = false): Promise<Status> {
    const file = path.join(root, 'README.md');
    const existing = readReadme(file, 'The repository needs a README with a packages block.');
    if (!existing.includes('<!-- docs:begin packages -->')) {
        throw new Error(`${file} needs a <!-- docs:begin packages --> / <!-- docs:end packages --> block`);
    }
    const block = renderPackagesBlock(await rows(root, 'packages'), await rows(root, 'tools'));
    return write(file, existing, applyBlocks(existing, { packages: block }, file, ROOT_NOTE), check);
}
