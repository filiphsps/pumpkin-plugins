// Removes the "release-as" pin from release-please-config.json for every plugin or action that has a version
// past its first release. Run it on a release PR branch: release-please only writes versions,
// changelogs and the manifest, so the pin would otherwise reach master, fail the release config
// check, and take the release and attach jobs down with it, leaving the release untagged with no
// .wasm attached. See "Registering a plugin for releases" in docs/ci-and-releases.md.
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.env.PUMPKIN_PLUGINS_ROOT ?? path.resolve(import.meta.dirname, '..');
const file = path.join(root, 'release-please-config.json');
const config = JSON.parse(fs.readFileSync(file, 'utf8'));

const retired = [];
for (const [dir, entry] of Object.entries(config.packages ?? {})) {
    if (entry['release-as'] === undefined) continue;
    const versionFile = dir.startsWith('actions/')
        ? path.join(root, dir, 'version.txt')
        : path.join(root, dir, 'package.json');
    if (!fs.existsSync(versionFile)) continue;
    const version = dir.startsWith('actions/')
        ? fs.readFileSync(versionFile, 'utf8').trim()
        : JSON.parse(fs.readFileSync(versionFile, 'utf8')).version;
    // Still on its starting version, so the pin is what makes its first release 0.0.1.
    if (version === '0.0.0') continue;
    config.packages[dir] = Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'release-as'));
    retired.push(`${dir} (at ${version})`);
}

if (!retired.length) {
    console.log('No plugin or action is past its first release, so every "release-as" stays.');
} else {
    fs.writeFileSync(file, `${JSON.stringify(config, null, 4)}\n`);
    console.log(`Removed "release-as" from ${retired.join(', ')}`);
}
