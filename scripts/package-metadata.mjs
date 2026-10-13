// Checks that the root package, every plugin in packages/ and every tool in tools/ carries the
// metadata npm and GitHub show (license, author, homepage, repository, bugs, funding, a short
// description) and, for libraries, the fields bundlers read (sideEffects, module, types, files,
// publishConfig). `--fix` writes everything that can be derived, so only the descriptions are
// written by hand. See "Package metadata" in docs/code-style.md.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { discoverComponents, localLicenseFile } from '@pumpkin-plugins/docs/node';
import { PUBLIC_TOOL_PACKAGE_PATHS } from './tool-packages.mjs';

const root = process.env.PUMPKIN_PLUGINS_ROOT ?? path.resolve(import.meta.dirname, '..');
const fix = process.argv.includes('--fix');

const REPO = 'https://github.com/filiphsps/pumpkin-plugins';
const AUTHOR = 'Filiph Sandström <filfat@hotmail.se> (https://github.com/filiphsps)';
const FUNDING = [
    { type: 'github', url: 'https://github.com/sponsors/filiphsps' },
    { type: 'custom', url: 'https://paypal.me/filiph' }
];
const MAX_DESCRIPTION = 70;
/** Canonical package names for tools that are published under public names. */
const EXPECTED_PUBLIC_TOOL_NAMES = PUBLIC_TOOL_PACKAGE_PATHS;

/** Order of keys in a package.json, so every one reads the same. Unknown keys go after these. */
const KEY_ORDER = [
    'name',
    'version',
    'private',
    'description',
    'license',
    'author',
    'contributors',
    'homepage',
    'repository',
    'bugs',
    'funding',
    'type',
    'sideEffects',
    'module',
    'types',
    'exports',
    'bin',
    'files',
    'publishConfig',
    'scripts',
    'dependencies',
    'peerDependencies',
    'devDependencies',
    'devEngines',
    'pumpkinPlugin'
];

/** Files a tool ships besides `src`, where it has them. */
const EXTRA_FILES = {
    'tools/build': ['dist', 'runtime', 'wasi-wit.lock.json'],
    'tools/pumpkin-api': ['wit.lock.json', 'compatibility', 'docs', 'README.md', 'LICENSE'],
    'tools/create-pumpkin-plugin': ['bin', 'dist', 'templates', 'README.md'],
    'tools/static-hermes-runtime': [
        'dist',
        'cmake',
        'hermes-patches',
        'hermes-source.lock.json',
        'toolchain-versions.json',
        'wasi-sdk.lock.json',
        'native',
        'README.md'
    ]
};

function hasEscapedUnicode(source) {
    // Scan JSON string tokens, consuming escaped backslashes so literal "\\u..." stays valid.
    for (const [token] of source.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
        for (const unicodeEscape of token.matchAll(/\\(?:u([0-9a-fA-F]{4})|.)/g)) {
            if (unicodeEscape[1] && Number.parseInt(unicodeEscape[1], 16) >= 0x80) return true;
        }
    }
    return false;
}

const hasLocalLicense = (dir) => dir !== '.' && Boolean(localLicenseFile(path.join(root, dir)));
const packageDirs = () => [
    '.',
    ...['packages', 'tools'].flatMap((group) => discoverComponents(root, group).map(({ slug }) => `${group}/${slug}`))
];
/** Find private benchmark workspaces that need release-registration checks. */
const benchmarkPackageDirs = () => {
    const directory = path.join(root, 'benchmarks');
    if (!fs.existsSync(directory)) return [];
    return fs
        .readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(directory, entry.name, 'package.json')))
        .map((entry) => `benchmarks/${entry.name}`);
};

/** What the package.json of `dir` should say, apart from the description. */
function expected(dir, pkg) {
    const isRoot = dir === '.';
    const want = {
        license: hasLocalLicense(dir) && typeof pkg.license === 'string' && pkg.license.trim() ? pkg.license : 'MIT',
        author: AUTHOR,
        contributors: [AUTHOR],
        homepage: isRoot ? REPO : `${REPO}/tree/master/${dir}#readme`,
        repository: { type: 'git', url: `git+${REPO}.git`, ...(isRoot ? {} : { directory: dir }) },
        bugs: { url: `${REPO}/issues` },
        funding: FUNDING
    };
    const binTargets = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {});
    const binSourceFiles = binTargets.some((target) => target.replace(/^\.\//, '').startsWith('bin/')) ? ['bin'] : [];
    // A library is a tool that others import: it has a root export, as opposed to a plugin or a CLI.
    const rootExport = pkg.exports?.['.'];
    if (dir.startsWith('tools/') && pkg.exports) {
        want.sideEffects = false;
        want.files = [
            ...(fs.existsSync(path.join(root, dir, 'src')) ? ['src'] : []),
            ...binSourceFiles,
            ...(EXTRA_FILES[dir] ?? [])
        ];
        want.publishConfig = { access: 'public' };
        if (typeof rootExport === 'string') {
            want.module = rootExport;
            want.types = rootExport;
        }
    } else if (dir.startsWith('tools/')) {
        want.files = [
            ...(fs.existsSync(path.join(root, dir, 'src')) ? ['src'] : []),
            ...binSourceFiles,
            ...(EXTRA_FILES[dir] ?? [])
        ];
    }
    if (Object.hasOwn(EXPECTED_PUBLIC_TOOL_NAMES, dir)) want.publishConfig = { access: 'public' };
    return want;
}

const ordered = (pkg) => {
    const keys = [...KEY_ORDER.filter((k) => k in pkg), ...Object.keys(pkg).filter((k) => !KEY_ORDER.includes(k))];
    return Object.fromEntries(keys.map((k) => [k, pkg[k]]));
};

const problems = [];
for (const dir of packageDirs()) {
    const file = path.join(dir, 'package.json');
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const pkg = JSON.parse(source);
    const want = expected(dir, pkg);
    const issues = [];
    const expectedName = EXPECTED_PUBLIC_TOOL_NAMES[dir];
    if (expectedName && pkg.name !== expectedName) issues.push(`"name" must remain ${JSON.stringify(expectedName)}`);
    if (expectedName && pkg.private === true) issues.push('public npm tools must not set "private": true');
    if (hasEscapedUnicode(source)) issues.push('non-ASCII characters must use literal UTF-8, not Unicode escapes');

    for (const [key, value] of Object.entries(want)) {
        if (JSON.stringify(pkg[key]) !== JSON.stringify(value))
            issues.push(`"${key}" should be ${JSON.stringify(value)}`);
    }
    if (typeof pkg.description !== 'string' || pkg.description.trim() === '') issues.push('"description" is missing');
    else if (pkg.description.length > MAX_DESCRIPTION) {
        issues.push(`"description" is ${pkg.description.length} characters; keep it under ${MAX_DESCRIPTION}`);
    }
    if (issues.length === 0 && JSON.stringify(Object.keys(pkg)) === JSON.stringify(Object.keys(ordered(pkg)))) continue;

    if (fix) {
        fs.writeFileSync(path.join(root, file), `${JSON.stringify(ordered({ ...pkg, ...want }), null, 4)}\n`);
        console.log(`updated ${file}`);
        // The description can't be derived, so a bad one still fails after fixing.
        for (const issue of issues.filter((i) => i.startsWith('"description"'))) problems.push(`${file}: ${issue}`);
    } else {
        for (const issue of issues) problems.push(`${file}: ${issue}`);
        if (issues.length === 0) problems.push(`${file}: keys are not in the standard order`);
    }
}

for (const dir of benchmarkPackageDirs()) {
    const file = path.join(dir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    if (pkg.private !== true) problems.push(`${file}: benchmark workspace packages must set "private": true`);
    const releaseConfigPath = path.join(root, 'release-please-config.json');
    if (fs.existsSync(releaseConfigPath)) {
        const packages = JSON.parse(fs.readFileSync(releaseConfigPath, 'utf8')).packages ?? {};
        if (Object.hasOwn(packages, dir))
            problems.push(`${file}: private benchmark packages cannot be in release-please-config.json`);
    }
    const manifestPath = path.join(root, '.release-please-manifest.json');
    if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (Object.hasOwn(manifest, dir))
            problems.push(`${file}: private benchmark packages cannot be in .release-please-manifest.json`);
    }
}

if (!fs.existsSync(path.join(root, 'LICENSE'))) problems.push('LICENSE is missing');

if (problems.length > 0) {
    console.error(`Package metadata is not as expected:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    console.error(
        '\nRun `node scripts/package-metadata.mjs --fix` to write what can be derived, then format with `pnpm lint:fix`.'
    );
    process.exit(1);
}
console.log(`Package metadata is complete for ${packageDirs().length} packages.`);
