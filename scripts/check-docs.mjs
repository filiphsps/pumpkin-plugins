// Fails when the hand-written docs no longer match the repo: a package without a README, a link or a
// path that doesn't exist, a `pnpm` command that isn't a script, a doc page missing from the index,
// a root script nobody documents, or a CI job the CI doc doesn't list. The generated parts of the
// READMEs are checked by `pnpm readme:check`. See "Docs match the code" in docs/code-style.md.
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.env.PUMPKIN_PLUGINS_ROOT ?? path.resolve(import.meta.dirname, '..');
const exists = (...parts) => fs.existsSync(path.join(root, ...parts));
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const problems = [];

/** Folders of `dir` that are packages. Folders starting with `_` are scratch space. */
function packageDirs(group) {
    if (!exists(group)) return [];
    return fs
        .readdirSync(path.join(root, group), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('_') && exists(group, d.name, 'package.json'))
        .map((d) => `${group}/${d.name}`);
}

function markdownFiles(dir) {
    if (!exists(dir)) return [];
    return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : markdownFiles(rel);
        return entry.name.endsWith('.md') ? [rel] : [];
    });
}

const packages = [...packageDirs('packages'), ...packageDirs('tools')];
const docs = [
    ...(exists('README.md') ? ['README.md'] : []),
    ...markdownFiles('docs'),
    ...packages.map((p) => `${p}/README.md`).filter((p) => exists(p)),
    ...markdownFiles('.github'),
    ...(exists('AGENTS.md') ? ['AGENTS.md'] : []),
    ...markdownFiles('.agents')
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

for (const file of docs) {
    for (const match of prose(read(file)).matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = match[1] ?? '';
        if (/^(https?:|mailto:)/.test(target)) continue;
        const [href, anchor] = target.split('#');
        const resolved = href ? path.posix.normalize(path.posix.join(path.posix.dirname(file), href)) : file;
        if (!exists(resolved)) {
            problems.push(`${file} links to ${target}, which does not exist`);
        } else if (anchor && resolved.endsWith('.md') && !anchors(resolved).has(anchor)) {
            problems.push(`${file} links to ${target}, but ${resolved} has no such heading`);
        }
    }
}

/** Only the code in a document: fenced blocks and code spans. */
const code = (text) => [...text.matchAll(/```[\s\S]*?```|`[^`\n]*`/g)].map((m) => m[0]).join('\n');

// Example names the docs use for a plugin that doesn't exist.
const PLACEHOLDERS = ['my-plugin'];

// 3. Repo paths in code spans exist.
const PATH_IN_CODE = /`((?:packages|tools|scripts|docs|\.github|\.agents)\/[\w./@-]+)`/g;
for (const file of docs) {
    for (const match of read(file).matchAll(PATH_IN_CODE)) {
        const target = (match[1] ?? '').replace(/[.,;:]+$/, '');
        if (PLACEHOLDERS.some((name) => target.includes(`/${name}`))) continue;
        if (!exists(target)) problems.push(`${file} mentions ${target}, which does not exist`);
    }
}

// 4. `pnpm <script>` commands name a script that exists somewhere in the workspace.
const rootScripts = Object.keys(JSON.parse(read('package.json')).scripts ?? {});
const scripts = new Set([
    ...rootScripts,
    ...packages.flatMap((p) => Object.keys(JSON.parse(read(p, 'package.json')).scripts ?? {}))
]);
const PNPM_BUILTINS = new Set([
    'install',
    'i',
    'add',
    'remove',
    'update',
    'exec',
    'dlx',
    'why',
    'list',
    'ls',
    'outdated',
    'store',
    'peers',
    'approve-builds',
    'licenses',
    'run'
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

// 6. The docs index lists every page, and every page it lists exists.
if (exists('docs', 'README.md')) {
    const index = read('docs', 'README.md');
    for (const page of markdownFiles('docs').filter((f) => f !== 'docs/README.md')) {
        const rel = page.slice('docs/'.length);
        if (!index.includes(`](${rel})`)) problems.push(`docs/README.md does not list ${page}`);
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
