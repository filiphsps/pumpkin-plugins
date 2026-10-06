// Updates each action README's example tag from its Release Please manifest entry.
// Unreleased actions use their release-as pin so their example points at the upcoming first
// release instead of version.txt/manifest 0.0.0. See "Releases" in docs/ci-and-releases.md.
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.env.PUMPKIN_PLUGINS_ROOT ?? path.resolve(import.meta.dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'release-please-config.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, '.release-please-manifest.json'), 'utf8'));
const actionsRoot = path.join(root, 'actions');

/** Escapes a string for use as a regular-expression literal. */
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const actionDirs = fs
    .readdirSync(actionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => ['action.yml', 'action.yaml'].some((file) => fs.existsSync(path.join(actionsRoot, name, file))))
    .sort();

for (const name of actionDirs) {
    const releasePath = `actions/${name}`;
    const releaseConfig = config.packages?.[releasePath];
    if (!releaseConfig)
        throw new Error(`${releasePath} has an action.yml but is missing from release-please-config.json`);

    const component = releaseConfig.component;
    if (typeof component !== 'string' || !component) {
        throw new Error(`${releasePath} needs a component in release-please-config.json`);
    }

    const manifestVersion = manifest[releasePath];
    if (typeof manifestVersion !== 'string') {
        throw new Error(`${releasePath} is missing a string version in .release-please-manifest.json`);
    }

    // Before the first release, the manifest stays at 0.0.0 while release-as pins the PR to 0.0.1.
    const version = manifestVersion === '0.0.0' ? releaseConfig['release-as'] : manifestVersion;
    if (typeof version !== 'string' || !version) {
        throw new Error(`${releasePath} is still at 0.0.0 but has no release-as first-release version`);
    }

    const readmePath = path.join(actionsRoot, name, 'README.md');
    if (!fs.existsSync(readmePath)) throw new Error(`${releasePath} is missing README.md`);

    const readme = fs.readFileSync(readmePath, 'utf8');
    const tagPattern = new RegExp(`(${escapeRegExp(component)}-v)[0-9][0-9A-Za-z.+-]*`, 'g');
    if (!tagPattern.test(readme)) {
        throw new Error(`${releasePath}/README.md has no example tag starting with ${component}-v`);
    }
    tagPattern.lastIndex = 0;
    const updatedReadme = readme.replace(tagPattern, `$1${version}`);

    if (updatedReadme !== readme) {
        fs.writeFileSync(readmePath, updatedReadme);
        console.log(`Updated ${releasePath}/README.md to ${component}-v${version}`);
    } else {
        console.log(`${releasePath}/README.md already uses ${component}-v${version}`);
    }
}
