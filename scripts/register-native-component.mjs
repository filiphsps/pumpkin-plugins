// Registers the Cargo component once its crate lands; never invent a package.json or a second version.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readNativeManifest } from '@pumpkin-plugins/docs/node';
import { Command } from 'commander';

const program = new Command()
    .name('register-native-component')
    .argument('<directory>', 'Native crate directory, e.g. native/pumpkin-plus-plus')
    .parse();
const [directory] = program.args;
if (!/^native\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(directory)) throw new Error('Expected a native/<component> Cargo path');
const root = process.env.PUMPKIN_PLUGINS_ROOT ?? resolve(import.meta.dirname, '..');
const cargo = readNativeManifest(join(root, directory, 'Cargo.toml'));
const component = directory.split('/').at(-1);
if (cargo.name !== component) throw new Error('Native Cargo package name must match its folder name');
const firstVersion = cargo.version === '0.0.0' ? '0.0.1' : cargo.version;
const configFile = join(root, 'release-please-config.json');
const manifestFile = join(root, '.release-please-manifest.json');
const config = JSON.parse(readFileSync(configFile, 'utf8'));
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
const expected = { component, 'release-type': 'rust', 'release-as': firstVersion };
const existing = config.packages?.[directory];
if (existing && Object.entries(expected).some(([key, value]) => existing[key] !== value))
    throw new Error(`Conflicting native release configuration for ${directory}`);
if (manifest[directory] !== undefined && manifest[directory] !== '0.0.0')
    throw new Error(`Native component ${directory} is already released`);
config.packages = Object.fromEntries(
    Object.entries({ ...config.packages, [directory]: expected }).sort(([a], [b]) => a.localeCompare(b)),
);
manifest[directory] = '0.0.0';
for (const [file, value] of [
    [configFile, config],
    [manifestFile, Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)))],
]) {
    const next = `${JSON.stringify(value, null, 4)}\n`;
    if (next !== readFileSync(file, 'utf8')) writeFileSync(file, next);
}
console.log(`Registered ${directory}: ${component}-v<version> (Cargo)`);
