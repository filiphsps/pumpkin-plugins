// Fails if a plugin under packages/ isn't set up for releases, and says exactly what to add.
// See "Registering a plugin for releases" in docs/ci-and-releases.md.
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.env.PUMPKIN_PLUGINS_ROOT ?? path.resolve(import.meta.dirname, '..');
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const config = read('release-please-config.json');
const manifest = read('.release-please-manifest.json');

const plugins = fs
    .readdirSync(path.join(root, 'packages'), { withFileTypes: true })
    .filter(
        (d) =>
            d.isDirectory() &&
            !d.name.startsWith('_') &&
            fs.existsSync(path.join(root, 'packages', d.name, 'package.json'))
    )
    .map((d) => `packages/${d.name}`);

const FIRST_VERSION_BASE = '0.0.0';
const FIRST_RELEASE = '0.0.1';

const problems = [];
if (config['separate-pull-requests'] !== true) {
    problems.push('release-please-config.json needs "separate-pull-requests": true for independent plugin releases');
}
if (config['always-update'] !== false) {
    problems.push('release-please-config.json needs "always-update": false to avoid empty follow-up releases');
}
if (config['force-tag-creation'] !== true) {
    problems.push(
        'release-please-config.json needs "force-tag-creation": true so the next run finds the previous release'
    );
}
for (const dir of plugins) {
    const name = path.basename(dir);
    const version = read(`${dir}/package.json`).version;

    const entry = config.packages?.[dir];
    if (!entry) {
        problems.push(
            `${dir} is not in release-please-config.json. Add under "packages": "${dir}": { "component": "${name}" }`
        );
    } else if (entry.component !== name) {
        problems.push(
            `${dir} needs "component": "${name}" in release-please-config.json (it becomes the tag prefix, ${name}-v<version>)`
        );
    }

    // The first release of every plugin is 0.0.1. `release-as` forces that whatever the first commits are
    // (a breaking change would otherwise make it 0.1.0), but it also pins every later release, so it
    // has to go as soon as the plugin has been released.
    const releaseAs = entry?.['release-as'];
    if (entry && manifest[dir] === FIRST_VERSION_BASE && releaseAs !== FIRST_RELEASE) {
        problems.push(
            `${dir} has not been released yet, so it needs "release-as": "${FIRST_RELEASE}" in release-please-config.json to make its first release ${FIRST_RELEASE}`
        );
    } else if (entry && manifest[dir] !== FIRST_VERSION_BASE && releaseAs !== undefined) {
        problems.push(
            `${dir} is released (${manifest[dir]}), so remove "release-as" from release-please-config.json: it would pin every later release to ${releaseAs}`
        );
    }

    if (!(dir in manifest)) {
        problems.push(`${dir} is not in .release-please-manifest.json. Add "${dir}": "${version}"`);
    } else if (manifest[dir] !== version) {
        problems.push(
            `.release-please-manifest.json has "${dir}": "${manifest[dir]}" but ${dir}/package.json is "${version}". They must match: release-please updates both on every release`
        );
    }
}
for (const dir of Object.keys(config.packages ?? {})) {
    if (!plugins.includes(dir)) problems.push(`release-please-config.json lists ${dir}, which is not a package`);
}
for (const dir of Object.keys(manifest)) {
    if (!plugins.includes(dir)) problems.push(`.release-please-manifest.json lists ${dir}, which is not a package`);
}

if (problems.length) {
    console.error(problems.map((p) => `- ${p}`).join('\n'));
    process.exit(1);
}
console.log(`Release config covers ${plugins.length} plugin(s): ${plugins.join(', ')}`);
