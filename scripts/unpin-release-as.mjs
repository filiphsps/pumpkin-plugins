// Removes the "release-as" pin from release-please-config.json after the manifest records the first release.
// Run it on a release PR branch: release-please only writes versions,
// changelogs and the manifest, so the pin would otherwise reach master, fail the release config
// check, and take the release and attach jobs down with it, leaving the release untagged with no
// release asset attached. See "Registering a component for releases" in docs/ci-and-releases.md.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readNativeManifest } from '@pumpkin-plugins/docs/node';

const root = process.env.PUMPKIN_PLUGINS_ROOT ?? path.resolve(import.meta.dirname, '..');
const file = path.join(root, 'release-please-config.json');
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
const manifestPath = path.join(root, '.release-please-manifest.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};

const retired = [];
for (const [dir, entry] of Object.entries(config.packages ?? {})) {
    if (entry['release-as'] === undefined) continue;
    const versionFile = dir.startsWith('actions/')
        ? path.join(root, dir, 'version.txt')
        : path.join(root, dir, dir.startsWith('native/') ? 'Cargo.toml' : 'package.json');
    if (!fs.existsSync(versionFile)) continue;
    const fileVersion = dir.startsWith('actions/')
        ? fs.readFileSync(versionFile, 'utf8').trim()
        : dir.startsWith('native/')
          ? readNativeManifest(versionFile).version
          : JSON.parse(fs.readFileSync(versionFile, 'utf8')).version;
    const version = manifest[dir] ?? fileVersion;
    // Keep first-release pins until Release Please advances the authoritative manifest version.
    if (version === '0.0.0') continue;
    config.packages[dir] = Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'release-as'));
    retired.push(`${dir} (at ${version})`);
}

if (!retired.length) {
    console.log('No component is past its first release, so every "release-as" stays.');
} else {
    fs.writeFileSync(file, `${JSON.stringify(config, null, 4)}\n`);
    console.log(`Removed "release-as" from ${retired.join(', ')}`);
}
