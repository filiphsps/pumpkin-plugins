// Checks that the root package, every plugin in packages/ and every tool in tools/ carries the
// metadata npm and GitHub show (license, author, homepage, repository, bugs, funding, a short
// description) and, for libraries, the fields bundlers read (sideEffects, module, types, files,
// publishConfig). `--fix` writes everything that can be derived, so only the descriptions are
// written by hand. See "Package metadata" in docs/code-style.md.
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.env.PUMPKIN_PLUGINS_ROOT ?? path.resolve(import.meta.dirname, '..');
const fix = process.argv.includes('--fix');

const REPO = 'https://github.com/filiphsps/pumpkin-plugins';
const AUTHOR = 'Filiph Sandström <filfat@hotmail.se> (https://github.com/filiphsps)';
const FUNDING = [
    { type: 'github', url: 'https://github.com/sponsors/filiphsps' },
    { type: 'custom', url: 'https://paypal.me/filiph' }
];
const MAX_DESCRIPTION = 70;

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
const EXTRA_FILES = { 'tools/build': ['runtime', 'wasi-wit.lock.json'] };

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

function hasLocalLicense(dir) {
    return (
        dir !== '.' &&
        fs
            .readdirSync(path.join(root, dir), { withFileTypes: true })
            .some((file) => file.isFile() && /^license(?:\.md|\.txt)?$/i.test(file.name))
    );
}

function packageDirs() {
    const dirs = ['.'];
    for (const group of ['packages', 'tools']) {
        for (const entry of fs.readdirSync(path.join(root, group), { withFileTypes: true })) {
            // Folders starting with `_` are scratch space, not packages.
            if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
            if (fs.existsSync(path.join(root, group, entry.name, 'package.json'))) dirs.push(`${group}/${entry.name}`);
        }
    }
    return dirs;
}

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
    // A library is a tool that others import: it has a root export, as opposed to a plugin or a CLI.
    const root = pkg.exports?.['.'];
    if (dir.startsWith('tools/') && pkg.exports) {
        want.sideEffects = false;
        want.files = ['src', ...(pkg.bin ? ['bin'] : []), ...(EXTRA_FILES[dir] ?? [])];
        want.publishConfig = { access: 'public' };
        if (typeof root === 'string') {
            want.module = root;
            want.types = root;
        }
    } else if (dir.startsWith('tools/')) {
        want.files = ['src', ...(pkg.bin ? ['bin'] : []), ...(EXTRA_FILES[dir] ?? [])];
    }
    return want;
}

const ordered = (pkg) => {
    const keys = [...KEY_ORDER.filter((k) => k in pkg), ...Object.keys(pkg).filter((k) => !KEY_ORDER.includes(k))];
    return Object.fromEntries(keys.map((k) => [k, pkg[k]]));
};

const problems = [];
for (const dir of packageDirs()) {
    const file = path.join(dir, 'package.json');
    const pkg = readJson(file);
    const want = expected(dir, pkg);
    const issues = [];

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

if (!fs.existsSync(path.join(root, 'LICENSE'))) problems.push('LICENSE is missing');

if (problems.length > 0) {
    console.error(`Package metadata is not as expected:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    console.error(
        '\nRun `node scripts/package-metadata.mjs --fix` to write what can be derived, then format with `pnpm lint:fix`.'
    );
    process.exit(1);
}
console.log(`Package metadata is complete for ${packageDirs().length} packages.`);
