// Fails when the hand-written docs no longer match the repo: a package without a README, a link or a
// path that doesn't exist, a `pnpm` command that isn't a script, a doc page missing from the index,
// a root script nobody documents, or a CI job the CI doc doesn't list. The generated parts of the
// READMEs are checked by `pnpm readme:check`. See "Docs match the code" in docs/code-style.md.
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    discoverComponents,
    discoverHandwrittenDocs,
    generateDocsIndex,
    walkMarkdown,
} from '@pumpkin-plugins/docs/node';

const root = process.env.PUMPKIN_PLUGINS_ROOT ?? path.resolve(import.meta.dirname, '..');
const exists = (...parts) => fs.existsSync(path.join(root, ...parts));
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const problems = [];

const packageDirs = (group) => discoverComponents(root, group).map(({ slug }) => `${group}/${slug}`);
const markdownFiles = (dir) =>
    walkMarkdown(path.join(root, dir), { exclude: [path.join(root, 'docs/api')] }).map((file) =>
        path.relative(root, file).split(path.sep).join('/'),
    );

const packages = [...packageDirs('packages'), ...packageDirs('extensions'), ...packageDirs('tools')];
const generatedPackageOutputs = new Set(
    packages.flatMap((dir) => {
        const manifest = JSON.parse(read(dir, 'package.json'));
        const binOutputs =
            typeof manifest.bin === 'string'
                ? [manifest.bin]
                : manifest.bin && typeof manifest.bin === 'object'
                  ? Object.values(manifest.bin)
                  : [];
        return [manifest.pumpkinPlugin?.output, ...binOutputs].flatMap((output) => {
            if (typeof output !== 'string' || path.posix.isAbsolute(output)) return [];
            const target = path.posix.normalize(path.posix.join(dir, output));
            return target.startsWith(`${dir}/`) ? [target] : [];
        });
    }),
);
const actions = discoverComponents(root, 'actions').map(({ slug }) => `actions/${slug}`);
const extensions = discoverComponents(root, 'extensions').map(({ slug }) => `extensions/${slug}`);
const native = packageDirs('native');
const handwrittenDocs = discoverHandwrittenDocs(root);
const docPagesBySiteRoute = new Map(
    handwrittenDocs.map((page) => [page.siteRoute.replace(/^\//, '').replace(/\/$/, ''), page.repositoryPath]),
);
/** Include the private engine-comparison package when checking documentation links and paths. */
const benchmarkDocs = exists('benchmarks/engine-comparison/README.md')
    ? ['benchmarks/engine-comparison/README.md', ...markdownFiles('benchmarks/engine-comparison')]
    : [];
const docs = [
    ...(exists('README.md') ? ['README.md'] : []),
    ...markdownFiles('docs'),
    ...packages.map((p) => `${p}/README.md`).filter((p) => exists(p)),
    ...packages.flatMap((p) => markdownFiles(`${p}/docs`)),
    ...actions.map((p) => `${p}/README.md`).filter((p) => exists(p)),
    ...actions.flatMap((p) => markdownFiles(`${p}/docs`)),
    ...extensions.map((p) => `${p}/README.md`).filter((p) => exists(p)),
    ...extensions.flatMap((p) => markdownFiles(`${p}/docs`)),
    ...native.map((p) => `${p}/README.md`).filter((p) => exists(p)),
    ...native.flatMap((p) => markdownFiles(`${p}/docs`)),
    ...benchmarkDocs,
    ...markdownFiles('.github'),
    ...(exists('AGENTS.md') ? ['AGENTS.md'] : []),
    ...markdownFiles('.agents'),
];

// 1. Every package has a README that names it.
if (!exists('README.md')) problems.push('README.md is missing');
for (const dir of packages) {
    if (!exists(dir, 'README.md')) {
        problems.push(`${dir}/README.md is missing. Every package needs at least a title and a short description`);
        continue;
    }
    const name = JSON.parse(read(dir, 'package.json')).name;
    const text = read(dir, 'README.md');
    if (!text.startsWith('# ')) problems.push(`${dir}/README.md must start with a "# " title`);
    if (dir.startsWith('tools/') && !text.includes(name)) problems.push(`${dir}/README.md should mention ${name}`);
    if (dir.startsWith('extensions/')) {
        const displayName = JSON.parse(read(dir, 'package.json')).displayName;
        if (typeof displayName !== 'string' || !text.includes(displayName)) {
            problems.push(`${dir}/README.md should mention its package.json displayName`);
        }
    }
}
for (const dir of [...actions, ...extensions, ...native]) {
    if (!exists(dir, 'README.md')) {
        problems.push(
            `${dir}/README.md is missing. Every action, extension and native component needs an overview and usage instructions`,
        );
    }
}

// 2. Relative links point at files that exist, and at headings that exist.
const slug = (heading) =>
    heading
        .toLowerCase()
        .replace(/`/g, '')
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .trim()
        .replace(/\s/g, '-');
const anchors = (file) =>
    new Set([...read(file).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((m) => slug(m[1] ?? '')).filter(Boolean));

/** Markdown text without code, so examples don't count as links. */
const prose = (text) => text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');

/** Resolve an absolute documentation-site route to its source Markdown file.
 *
 * @param href - Absolute VitePress route.
 * @returns Repository-relative Markdown path, or `undefined` for an unknown route family.
 */
function resolveSiteRoute(href) {
    const route = href.replace(/^\//, '');
    const discoveredPage = docPagesBySiteRoute.get(route.replace(/\/$/, ''));
    if (discoveredPage) return discoveredPage;
    if (route.startsWith('guides/')) {
        if (route === 'guides/' || route === 'guides/index') return 'docs/README.md';
        const source = path.posix.join('docs', route.slice('guides/'.length));
        return source.endsWith('/') ? `${source}index.md` : /\.md$/.test(source) ? source : `${source}.md`;
    }
    if (route.startsWith('api/')) {
        const source = path.posix.join('docs', route);
        return source.endsWith('/') ? `${source}index.md` : /\.md$/.test(source) ? source : `${source}/index.md`;
    }
    return undefined;
}

for (const file of docs) {
    for (const match of prose(read(file)).matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = match[1] ?? '';
        if (/^(https?:|mailto:)/.test(target)) continue;
        const [href, anchor] = target.split('#');
        const resolved = href
            ? href.startsWith('/')
                ? (resolveSiteRoute(href) ?? path.posix.normalize(path.posix.join(path.posix.dirname(file), href)))
                : path.posix.normalize(path.posix.join(path.posix.dirname(file), href))
            : file;
        if (!exists(resolved)) {
            // API pages are generated during the docs build and intentionally ignored by Git.
            if (!(href.startsWith('/api/') && !exists('docs/api'))) {
                problems.push(`${file} links to ${target}, which does not exist`);
            }
        } else if (anchor && resolved.endsWith('.md') && !anchors(resolved).has(anchor)) {
            problems.push(`${file} links to ${target}, but ${resolved} has no such heading`);
        }
    }
}

/** Only the code in a document: fenced blocks and code spans. */
const code = (text) => [...text.matchAll(/```[\s\S]*?```|`[^`\n]*`/g)].map((m) => m[0]).join('\n');

// Example names the docs use for a plugin that doesn't exist.
const PLACEHOLDERS = ['my-plugin', 'my-action'];

// 3. Repo paths in code spans exist.
const PATH_IN_CODE =
    /`((?:packages|tools|actions|extensions|native|benchmarks|scripts|docs|\.github|\.agents)\/[\w./@-]+)`/g;
for (const file of docs) {
    for (const match of read(file).matchAll(PATH_IN_CODE)) {
        const target = (match[1] ?? '').replace(/[.,;:]+$/, '');
        if (PLACEHOLDERS.some((name) => target.includes(`/${name}`))) continue;
        if (
            target.startsWith('actions/') &&
            !actions.some((action) => target === action || target.startsWith(`${action}/`)) &&
            !target.slice('actions/'.length).includes('/')
        ) {
            continue;
        }
        if (!exists(target) && !generatedPackageOutputs.has(target)) {
            problems.push(`${file} mentions ${target}, which does not exist`);
        }
    }
}

// 4. `pnpm <script>` commands name a script that exists somewhere in the workspace.
const rootScripts = Object.keys(JSON.parse(read('package.json')).scripts ?? {});
const scripts = new Set([
    ...rootScripts,
    ...packages.flatMap((p) => Object.keys(JSON.parse(read(p, 'package.json')).scripts ?? {})),
]);
const PNPM_BUILTINS = new Set([
    'install',
    'i',
    'add',
    'remove',
    'update',
    'exec',
    'create',
    'dlx',
    'why',
    'list',
    'ls',
    'outdated',
    'store',
    'peers',
    'approve-builds',
    'licenses',
    'run',
]);
for (const file of docs) {
    for (const match of code(read(file)).matchAll(/\bpnpm\s+(run\s+)?([a-z][\w:-]*)/g)) {
        const command = match[2] ?? '';
        if (match[1] === undefined && PNPM_BUILTINS.has(command)) continue;
        if (!scripts.has(command))
            problems.push(`${file} runs \`pnpm ${command}\`, which is not a script of any package`);
    }
}

// 5. Every root script is documented, so a new one can't go unmentioned.
const documented = docs.map((f) => code(read(f))).join('\n');
for (const script of rootScripts) {
    if (!new RegExp(`pnpm (run )?${script.replace(/[:]/g, '\\:')}\\b`).test(documented)) {
        problems.push(`package.json has the script "${script}", which no doc mentions as \`pnpm ${script}\``);
    }
}

// 6. The docs index is generated from the guide categories and nested source folders.
if (exists('docs', 'README.md')) {
    if (generateDocsIndex(root, true) === 'stale') {
        problems.push('docs/README.md has stale guide and docs menus; run `pnpm readme`');
    }
}

// 7. The CI doc lists every job in the workflow (by emoji and first word, which is how it names them).
if (exists('.github/workflows/ci.yml') && exists('docs', 'ci-and-releases.md')) {
    const doc = read('docs', 'ci-and-releases.md');
    for (const match of read('.github/workflows/ci.yml').matchAll(/^ {8}name: (.+)$/gm)) {
        const name = (match[1] ?? '')
            .replace(/\$\{\{[^}]*\}\}/g, '')
            .replace(/\([^)]*\)/g, '')
            .trim();
        const [emoji, word] = name.split(/\s+/);
        if (emoji && word && !new RegExp(`${emoji}\\s+${word}`, 'i').test(doc)) {
            problems.push(`docs/ci-and-releases.md does not list the CI job "${name}"`);
        }
    }
}

if (problems.length > 0) {
    console.error(`The docs do not match the repo:\n${[...new Set(problems)].map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
}
console.log(`Docs match the repo (${docs.length} files, ${packages.length} packages).`);
