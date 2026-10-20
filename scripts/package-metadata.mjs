// Checks workspace-derived package metadata and fixes values that have a single source of truth.
// See "Package metadata" in docs/code-style.md.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { discoverComponents, localLicenseFile } from '@pumpkin-plugins/docs/node';
import { Command } from 'commander';
import { nodeEngineRange } from './utils/tool-packages.mjs';

const program = new Command()
    .name('package-metadata')
    .description('Check package metadata and optionally fix values derived from the workspace.')
    .option('--fix', 'Write metadata values that can be derived')
    .parse(process.argv);
const root = process.env.PUMPKIN_PLUGINS_ROOT ?? path.resolve(import.meta.dirname, '..');
const fix = program.opts().fix ?? false;

const MAX_DESCRIPTION = 70;
const hasLocalLicense = (dir) => dir !== '.' && Boolean(localLicenseFile(path.join(root, dir)));
const packageDirs = () => [
    '.',
    ...['packages', 'extensions', 'tools'].flatMap((group) =>
        discoverComponents(root, group).map(({ slug }) => `${group}/${slug}`),
    ),
];
/** Find the private benchmark workspaces, which must stay unpublished. */
const benchmarkPackageDirs = () => {
    const directory = path.join(root, 'benchmarks');
    if (!fs.existsSync(directory)) return [];
    return fs
        .readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(directory, entry.name, 'package.json')))
        .map((entry) => `benchmarks/${entry.name}`);
};

const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const repository = rootPackage.repository;
const repositoryUrl = typeof repository === 'string' ? repository : repository?.url;
if (typeof repositoryUrl !== 'string') throw new Error('root package.json must declare repository.url');
const webRepositoryUrl = repositoryUrl.replace(/^git\+/, '').replace(/\.git$/, '');

/** What the package.json of `dir` can derive from the workspace and its own exports. */
function expected(dir, pkg) {
    const isRoot = dir === '.';
    const want = {
        license: hasLocalLicense(dir) && typeof pkg.license === 'string' && pkg.license.trim() ? pkg.license : 'MIT',
        homepage: isRoot ? webRepositoryUrl : `${webRepositoryUrl}/tree/master/${dir}#readme`,
        repository: isRoot
            ? repository
            : { ...(typeof repository === 'string' ? { url: repository } : repository), directory: dir },
        bugs: rootPackage.bugs,
    };
    // A library is a tool that others import: it has a root export, as opposed to a plugin or a CLI.
    const rootExport = pkg.exports?.['.'];
    if (dir.startsWith('tools/') && pkg.exports) {
        want.sideEffects = false;
        if (typeof rootExport === 'string') {
            want.module = rootExport;
            want.types = rootExport;
        }
    }
    if (dir.startsWith('tools/') && pkg.private !== true && pkg.publishConfig?.access === 'public') {
        want.engines = { node: nodeEngineRange(root) };
    }
    return want;
}

const problems = [];
for (const dir of packageDirs()) {
    const file = path.join(dir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    const want = expected(dir, pkg);
    const issues = [];

    for (const [key, value] of Object.entries(want)) {
        if (JSON.stringify(pkg[key]) !== JSON.stringify(value))
            issues.push(`"${key}" should be ${JSON.stringify(value)}`);
    }
    if (typeof pkg.description !== 'string' || pkg.description.trim() === '') issues.push('"description" is missing');
    else if (pkg.description.length > MAX_DESCRIPTION) {
        issues.push(`"description" is ${pkg.description.length} characters; keep it to at most ${MAX_DESCRIPTION}`);
    }
    if (issues.length === 0) continue;

    if (fix) {
        fs.writeFileSync(path.join(root, file), `${JSON.stringify({ ...pkg, ...want }, null, 4)}\n`);
        console.log(`updated ${file}`);
        // The description can't be derived, so a bad one still fails after fixing.
        for (const issue of issues.filter((i) => i.startsWith('"description"'))) problems.push(`${file}: ${issue}`);
    } else {
        for (const issue of issues) problems.push(`${file}: ${issue}`);
    }
}

for (const dir of benchmarkPackageDirs()) {
    const file = path.join(dir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    if (pkg.private !== true) problems.push(`${file}: benchmark workspace packages must set "private": true`);
}

if (!fs.existsSync(path.join(root, 'LICENSE'))) problems.push('LICENSE is missing');

if (problems.length > 0) {
    console.error(`Package metadata is not as expected:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    console.error(
        '\nRun `node scripts/package-metadata.mjs --fix` to write what can be derived, then format with `pnpm lint:fix`.',
    );
    process.exit(1);
}
console.log(`Package metadata is complete for ${packageDirs().length} packages.`);
