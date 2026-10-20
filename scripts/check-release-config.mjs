// Fails if a plugin, action, extension, or public tool isn't registered for releases.
// See the release registration guides in docs/ci-and-releases.md.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { discoverComponents } from '@pumpkin-plugins/docs/node';
import { publicToolReleaseTitleOptions } from './utils/release-pr-title.mjs';
import { discoverPublicToolPackages } from './utils/tool-packages.mjs';

const root = process.env.PUMPKIN_PLUGINS_ROOT ?? path.resolve(import.meta.dirname, '..');
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const config = read('release-please-config.json');
const manifest = read('.release-please-manifest.json');
const pausedPath = path.join(root, 'release-please-paused.json');
const paused = fs.existsSync(pausedPath) ? read('release-please-paused.json') : {};
const problems = [];

if (!paused || typeof paused !== 'object' || Array.isArray(paused)) {
    problems.push('release-please-paused.json must be a JSON object mapping package paths to reasons');
}
const pausedEntries = paused && typeof paused === 'object' && !Array.isArray(paused) ? Object.entries(paused) : [];

const discoveredPlugins = discoverComponents(root, 'packages').map(({ slug }) => `packages/${slug}`);
const discoveredPluginPaths = new Set(discoveredPlugins);
const pausedPlugins = new Set();
for (const [dir, reason] of pausedEntries) {
    if (!/^packages\/[^/]+$/.test(dir)) problems.push(`${dir} in release-please-paused.json is not a plugin path`);
    if (!discoveredPluginPaths.has(dir)) problems.push(`${dir} in release-please-paused.json does not exist`);
    if (typeof reason !== 'string' || !reason.trim()) {
        problems.push(`${dir} in release-please-paused.json needs a non-empty reason`);
    }
    if (Object.hasOwn(config.packages ?? {}, dir)) {
        problems.push(`${dir} is paused but still listed in release-please-config.json`);
    }
    if (Object.hasOwn(manifest, dir))
        problems.push(`${dir} is paused but still listed in .release-please-manifest.json`);
    pausedPlugins.add(dir);
}
const plugins = discoveredPlugins.filter((dir) => !pausedPlugins.has(dir));
const actions = discoverComponents(root, 'actions').map(({ slug }) => `actions/${slug}`);
const extensions = discoverComponents(root, 'extensions').map(({ slug }) => `extensions/${slug}`);
const publicTools = discoverPublicToolPackages(root);
const tools = publicTools.map(({ path: packagePath }) => packagePath);
for (const dir of actions) {
    for (const file of ['README.md', 'CHANGELOG.md', 'version.txt']) {
        if (!fs.existsSync(path.join(root, dir, file))) problems.push(`${dir}/${file} is missing`);
    }
}
for (const dir of extensions) {
    for (const file of ['README.md', 'CHANGELOG.md']) {
        if (!fs.existsSync(path.join(root, dir, file))) problems.push(`${dir}/${file} is missing`);
    }
}
const components = new Map(
    /** @type {Array<[string, { type: string, version: string, packageName?: string }]>} */ ([
        ...plugins.map((dir) => [dir, { type: 'plugin', version: read(`${dir}/package.json`).version }]),
        ...publicTools.map(({ path: dir, name, packageJson }) => [
            dir,
            { type: 'tool', version: packageJson.version, packageName: name },
        ]),
        ...extensions.map((dir) => [dir, { type: 'extension', version: read(`${dir}/package.json`).version }]),
        ...actions.map((dir) => [
            dir,
            {
                type: 'action',
                version: fs.existsSync(path.join(root, dir, 'version.txt'))
                    ? fs.readFileSync(path.join(root, dir, 'version.txt'), 'utf8').trim()
                    : '',
            },
        ]),
    ]),
);

const FIRST_VERSION_BASE = '0.0.0';
const FIRST_RELEASE = '0.0.1';
const FIRST_TOOL_RELEASE = '0.1.0';

if (config['separate-pull-requests'] !== true) {
    problems.push('release-please-config.json needs "separate-pull-requests": true for independent component releases');
}
if (config['always-update'] !== true) {
    problems.push('release-please-config.json needs "always-update": true so remaining release PRs follow master');
}
if (config['force-tag-creation'] !== true) {
    problems.push(
        'release-please-config.json needs "force-tag-creation": true so the next run finds the previous release',
    );
}
for (const [option, behavior] of [
    ['bump-minor-pre-major', 'breaking changes bump the minor version below 1.0.0'],
    ['bump-patch-for-minor-pre-major', 'features bump the patch version below 1.0.0'],
]) {
    if (config[option] !== true) {
        problems.push(`release-please-config.json needs "${option}": true so ${behavior}`);
    }
    for (const [dir, entry] of Object.entries(config.packages ?? {})) {
        if (entry?.[option] === false) {
            problems.push(`${dir} cannot set "${option}": false; ${behavior}`);
        }
    }
}
for (const [dir, { type, version, packageName }] of components) {
    const name = path.basename(dir);

    const entry = config.packages?.[dir];
    if (!entry) {
        problems.push(
            `${dir} is not in release-please-config.json. Add under "packages": "${dir}": { "component": "${name}" }`,
        );
    } else if (entry.component !== name) {
        problems.push(
            `${dir} needs "component": "${name}" in release-please-config.json (it becomes the tag prefix, ${name}-v<version>)`,
        );
    }
    if (type === 'action' && entry?.['release-type'] !== 'simple') {
        problems.push(`${dir} needs "release-type": "simple" in release-please-config.json`);
    }
    if (type === 'tool') {
        try {
            const titleOptions = publicToolReleaseTitleOptions(packageName, name);
            for (const [option, expected] of Object.entries(titleOptions)) {
                if (entry?.[option] !== expected) {
                    problems.push(
                        `${dir} needs "${option}": ${JSON.stringify(expected)} in release-please-config.json so its release PR title includes ${packageName}`,
                    );
                }
            }
        } catch (error) {
            problems.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // Plugins, actions and extensions start at 0.0.0 and use 0.0.1 as their first release. Public
    // tools retain their pre-release package version and use a 0.0.0 manifest baseline until their
    // first 0.1.0 tag.
    const releaseAs = entry?.['release-as'];
    if (type === 'tool' && entry && manifest[dir] === FIRST_VERSION_BASE && releaseAs !== FIRST_TOOL_RELEASE) {
        problems.push(
            `${dir} has not been released yet, so it needs "release-as": "${FIRST_TOOL_RELEASE}" in release-please-config.json to make its first release ${FIRST_TOOL_RELEASE}`,
        );
    } else if (entry && type !== 'tool' && manifest[dir] === FIRST_VERSION_BASE && releaseAs !== FIRST_RELEASE) {
        problems.push(
            `${dir} has not been released yet, so it needs "release-as": "${FIRST_RELEASE}" in release-please-config.json to make its first release ${FIRST_RELEASE}`,
        );
    } else if (entry && manifest[dir] !== FIRST_VERSION_BASE && releaseAs !== undefined) {
        problems.push(
            `${dir} is released (${manifest[dir]}), so remove "release-as" from release-please-config.json: it would pin every later release to ${releaseAs}`,
        );
    }

    if (!(dir in manifest)) {
        problems.push(`${dir} is not in .release-please-manifest.json. Add "${dir}": "${version}"`);
    } else if (type === 'tool' && manifest[dir] === FIRST_VERSION_BASE) {
        if (version !== FIRST_TOOL_RELEASE) {
            problems.push(`${dir}/package.json must be "${FIRST_TOOL_RELEASE}" before its first public release`);
        }
    } else if (manifest[dir] !== version) {
        problems.push(
            `.release-please-manifest.json has "${dir}": "${manifest[dir]}" but ${type === 'action' ? `${dir}/version.txt` : `${dir}/package.json`} is "${version}". They must match: release-please updates both on every release`,
        );
    }
}
for (const dir of Object.keys(config.packages ?? {})) {
    if (!components.has(dir))
        problems.push(`release-please-config.json lists ${dir}, which is not a discovered release component`);
}
for (const dir of Object.keys(manifest)) {
    if (!components.has(dir))
        problems.push(`.release-please-manifest.json lists ${dir}, which is not a discovered release component`);
}

if (problems.length) {
    console.error(problems.map((p) => `- ${p}`).join('\n'));
    process.exit(1);
}
const pausedSummary = pausedPlugins.size ? `; ${pausedPlugins.size} paused: ${[...pausedPlugins].join(', ')}` : '';
console.log(
    `Release config covers ${plugins.length} plugin${plugins.length === 1 ? '' : 's'}, ${actions.length} action${actions.length === 1 ? '' : 's'}, ${tools.length} public tool${tools.length === 1 ? '' : 's'}, and ${extensions.length} extension${extensions.length === 1 ? '' : 's'}: ${[...components.keys()].join(', ')}${pausedSummary}`,
);
