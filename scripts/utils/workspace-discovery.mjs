// Discovers what scripts/changed-areas.mjs selects CI jobs from: the tracked files, the workspace
// packages, the root manifest, the Turborepo configuration and the workflows. The classifier
// discovers them once and passes the result to each job's input finder.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
// CI classifies a change before it installs dependencies, so import the discovery source by path.
import { discoverComponents } from '../../tools/docs/src/discovery.ts';

/** The folders that hold workspace packages, the same ones scripts/clean.mjs cleans. */
const WORKSPACE_GROUPS = ['benchmarks', 'extensions', 'packages', 'tools'];

/** The manifest fields that declare a package's dependencies. */
export const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/**
 * Lists the tracked files and reads the workspace packages by name, the root manifest, the
 * Turborepo configuration and the workflow files.
 *
 * @throws When Git cannot list the tracked files.
 */
export function discoverWorkspace(root) {
    const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
    if (tracked.status !== 0) throw new Error(`Could not list repository files: ${tracked.stderr.trim()}`);
    const files = tracked.stdout.split('\0').filter(Boolean);
    const read = (file) => readFileSync(path.join(root, file), 'utf8');
    const packages = new Map();
    for (const group of WORKSPACE_GROUPS) {
        for (const { slug, metadataFile } of discoverComponents(root, group)) {
            const manifest = JSON.parse(readFileSync(metadataFile, 'utf8'));
            if (typeof manifest.name === 'string') {
                packages.set(manifest.name, { name: manifest.name, directory: `${group}/${slug}`, manifest });
            }
        }
    }
    // The Turborepo configuration is the root JSON file with tasks and global dependencies.
    const turboConfigFile = files.find((file) => {
        if (file.includes('/') || !file.endsWith('.json')) return false;
        const config = JSON.parse(read(file));
        return config.tasks && Array.isArray(config.globalDependencies);
    });
    return {
        files,
        read,
        packages,
        rootManifest: JSON.parse(read('package.json')),
        turboConfigFile,
        turboConfig: turboConfigFile ? JSON.parse(read(turboConfigFile)) : undefined,
        workflowFiles: files.filter((file) => file.startsWith('.github/workflows/') && /\.ya?ml$/.test(file)),
    };
}

/** Returns the first workflow job with this name, as its workflow file and the job's lines. */
export function workflowJob({ read, workflowFiles }, name) {
    // CI runs the classifier before it installs a YAML parser; the workflows indent jobs by four spaces.
    for (const file of workflowFiles) {
        const lines = read(file).split('\n');
        const start = lines.findIndex((line) => line.trimEnd() === `    ${name}:`);
        if (start === -1) continue;
        const nextJob = lines.findIndex((line, index) => index > start && /^ {4}[\w-]+:\s*$/.test(line));
        return { file, source: lines.slice(start, nextJob === -1 ? undefined : nextJob).join('\n') };
    }
    return undefined;
}

/** Returns the local actions and workflows that workflow source uses with `uses: ./path`. */
export function localUses(source) {
    return [...source.matchAll(/^\s*(?:-\s*)?uses:\s+\.\/([^#\s@]+)/gm)].map(([, localPath]) =>
        path.posix.normalize(localPath),
    );
}

/**
 * Collects the directories of the named workspace packages and of the workspace packages they
 * depend on, transitively, through the given manifest fields.
 */
export function dependencyClosure(packages, names, fields = DEPENDENCY_FIELDS) {
    const directories = new Set();
    const visit = (name) => {
        const workspacePackage = packages.get(name);
        if (!workspacePackage || directories.has(workspacePackage.directory)) return;
        directories.add(workspacePackage.directory);
        for (const field of fields) {
            for (const dependency of Object.keys(workspacePackage.manifest[field] ?? {})) visit(dependency);
        }
    };
    for (const name of names) visit(name);
    return directories;
}

/** Finds the actions whose source imports the shared `actions/common/` helpers. */
export function commonHelperConsumers({ files, read }) {
    const consumers = new Set();
    for (const file of files) {
        const [, action] = file.match(/^actions\/([^/]+)\/src\/[^/]+\.m?js$/) ?? [];
        if (action && action !== 'common' && read(file).includes('../../common/')) consumers.add(action);
    }
    return consumers;
}
