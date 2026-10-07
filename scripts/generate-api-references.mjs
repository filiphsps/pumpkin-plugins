import fs from 'node:fs';
import path from 'node:path';
import { Application, TSConfigReader } from 'typedoc';
import { parse } from 'yaml';

const repoRoot = path.resolve(import.meta.dirname, '..');
const apiRoot = path.join(repoRoot, 'docs/api');
const repository = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).repository;
const repoUrl = (typeof repository === 'string' ? repository : repository.url)
    .replace(/^git\+/, '')
    .replace(/\.git$/, '');
const commonOptions = JSON.parse(fs.readFileSync(path.join(repoRoot, 'typedoc.json'), 'utf8'));
const editLink = (sourcePath) => `${repoUrl}/edit/master/${sourcePath}`;

process.chdir(repoRoot);
fs.rmSync(apiRoot, { recursive: true, force: true });

/** Finds source components by their package manifests, without maintaining a separate list. */
function packages(group) {
    const directory = path.join(repoRoot, group);
    if (!fs.existsSync(directory)) return [];

    return fs
        .readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
        .flatMap((entry) => {
            const componentDirectory = path.join(directory, entry.name);
            const manifestPath = path.join(componentDirectory, 'package.json');
            const sourceDirectory = path.join(componentDirectory, 'src');
            if (!fs.existsSync(manifestPath) || !fs.existsSync(sourceDirectory)) return [];

            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            return [{ slug: entry.name, directory: componentDirectory, manifest }];
        })
        .sort((left, right) => left.slug.localeCompare(right.slug));
}

/** Generates a Markdown reference tree from JSDoc comments in a component's source directory. */
async function generateTypeDoc({ entryPoints, tsconfig, out, name, exclude = [] }) {
    fs.rmSync(out, { recursive: true, force: true });
    const app = await Application.bootstrapWithPlugins(
        {
            ...commonOptions,
            entryPoints,
            entryPointStrategy: 'expand',
            tsconfig,
            out,
            name,
            exclude: [...(commonOptions.exclude ?? []), ...exclude]
        },
        [new TSConfigReader()]
    );
    const project = await app.convert();
    if (!project) throw new Error(`TypeDoc could not convert ${name}`);
    await app.generateOutputs(project);
}

function writePage(file, sourcePath, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const frontmatter = `---\neditLink: ${JSON.stringify(editLink(sourcePath))}\n---\n\n`;
    fs.writeFileSync(file, `${frontmatter}${content.trim()}\n`);
}

function componentIndex(title, items, routePrefix) {
    const list = items
        .map(({ slug, label, description }) => `- [${label}](${routePrefix}/${slug}/) — ${description}`)
        .join('\n');
    return `# ${title}\n\n${list || 'No references are available yet.'}`;
}

/** Formats action metadata as a Markdown table cell. */
function tableCell(value) {
    return String(value ?? '—')
        .replaceAll('|', '\\|')
        .replaceAll(/\s*\n\s*/g, ' ');
}

function actionPage(slug, actionFile, action) {
    const sourceFile = action.runs?.main ?? 'src/index.mjs';
    const inputs = Object.entries(action.inputs ?? {});
    const outputs = Object.entries(action.outputs ?? {});
    const inputRows = inputs.map(([name, input]) => {
        const required = input.required === true || input.required === 'true' ? 'Yes' : 'No';
        const defaultValue = Object.hasOwn(input, 'default')
            ? input.default === ''
                ? '`(empty string)`'
                : `\`${tableCell(input.default)}\``
            : '—';
        return `| \`${name}\` | ${required} | ${defaultValue} | ${tableCell(input.description)} |`;
    });
    const outputRows = outputs.map(([name, output]) => `| \`${name}\` | ${tableCell(output.description)} |`);
    const sourcePath = path.relative(repoRoot, actionFile).split(path.sep).join('/');
    const implementationPath = path
        .relative(repoRoot, path.join(path.dirname(actionFile), sourceFile))
        .split(path.sep)
        .join('/');

    return {
        sourcePath,
        content: `# ${action.name ?? slug}

${action.description ?? ''}

This reference is generated from [\`${path.basename(actionFile)}\`](${repoUrl}/blob/master/${sourcePath}).

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
${inputRows.length ? inputRows.join('\n') : '| — | — | — | This action has no inputs. |'}

## Outputs

| Output | Description |
| --- | --- |
${outputRows.length ? outputRows.join('\n') : '| — | This action has no outputs. |'}

## Implementation reference

- [JSDoc reference](code/)
- [Action entry point source](${repoUrl}/blob/master/${implementationPath})`
    };
}

function moduleSourcePath(directory, moduleParts, extensions) {
    if (!moduleParts.length) return undefined;
    const modulePath = path.join(directory, ...moduleParts);
    for (const extension of extensions) {
        if (fs.existsSync(`${modulePath}${extension}`)) return `${modulePath}${extension}`;
        if (fs.existsSync(path.join(modulePath, `index${extension}`))) {
            return path.join(modulePath, `index${extension}`);
        }
    }
    return undefined;
}

/** Resolves an edit target for generated pages that do not have a TypeDoc source link. */
function fallbackSourcePath(relativePage) {
    const parts = relativePage.split('/');
    if (parts[0] === 'plugins' && parts[1]) {
        const pluginDirectory = `packages/${parts[1]}`;
        const moduleParts = parts.slice(2, -1);
        const moduleSource = moduleSourcePath(path.join(repoRoot, pluginDirectory, 'src'), moduleParts, [
            '.ts',
            '.tsx'
        ]);
        if (moduleSource) return path.relative(repoRoot, moduleSource).split(path.sep).join('/');
        if (!moduleParts.length) {
            const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, pluginDirectory, 'package.json'), 'utf8'));
            if (manifest.pumpkinPlugin?.entry) return `${pluginDirectory}/${manifest.pumpkinPlugin.entry}`;
        }
        return `${pluginDirectory}/README.md`;
    }
    if (parts[0] === 'tools' && parts[1] === '@pumpkin-plugins' && parts[2]) {
        const toolDirectory = `tools/${parts[2]}`;
        const moduleParts = parts.slice(3, -1);
        const moduleSource = moduleSourcePath(path.join(repoRoot, toolDirectory, 'src'), moduleParts, ['.ts', '.tsx']);
        return moduleSource
            ? path.relative(repoRoot, moduleSource).split(path.sep).join('/')
            : `${toolDirectory}/README.md`;
    }
    if (parts[0] === 'actions' && parts[1]) {
        const actionDirectory = path.join(repoRoot, 'actions', parts[1]);
        const yamlName = fs.existsSync(path.join(actionDirectory, 'action.yml')) ? 'action.yml' : 'action.yaml';
        if (parts[2] === 'code') {
            const action = parse(fs.readFileSync(path.join(actionDirectory, yamlName), 'utf8'));
            const moduleParts = parts.slice(3, -1);
            const moduleSource = moduleSourcePath(path.join(actionDirectory, 'src'), moduleParts, ['.mjs', '.js']);
            if (moduleSource) return path.relative(repoRoot, moduleSource).split(path.sep).join('/');
            return `actions/${parts[1]}/${action.runs?.main ?? 'src/index.mjs'}`;
        }
        return `actions/${parts[1]}/${yamlName}`;
    }
    if (parts[0] === 'scripts') {
        const moduleSource = moduleSourcePath(path.join(repoRoot, 'scripts'), parts.slice(1, -1), ['.mjs', '.js']);
        if (moduleSource) return path.relative(repoRoot, moduleSource).split(path.sep).join('/');
    }
    return relativePage.startsWith('tools/') ? 'typedoc.json' : 'scripts/generate-api-references.mjs';
}

/** Adds a native VitePress edit-link target to each generated API Markdown page. */
function addEditLinks() {
    const sourceUrl = new RegExp(`${repoUrl}/blob/[^/]+/([^\\s)#]+)`);
    const visit = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                visit(file);
                continue;
            }
            if (!entry.name.endsWith('.md')) continue;

            const content = fs.readFileSync(file, 'utf8');
            if (content.startsWith('---\n')) continue;
            const relativePage = path.relative(apiRoot, file).split(path.sep).join('/');
            const sourcePath = content.match(sourceUrl)?.[1] ?? fallbackSourcePath(relativePage);
            const frontmatter = `---\neditLink: ${JSON.stringify(editLink(sourcePath))}\n---\n\n`;
            fs.writeFileSync(file, `${frontmatter}${content}`);
        }
    };
    visit(apiRoot);
}

const pluginPackages = packages('packages').filter(({ manifest }) => manifest.pumpkinPlugin);
const toolPackages = packages('tools');

for (const component of [...pluginPackages, ...toolPackages]) {
    const group = pluginPackages.includes(component) ? 'plugins' : 'tools';
    const outputName = group === 'plugins' ? component.slug : component.manifest.name;
    const out = path.join(apiRoot, group, outputName);
    const sourceDirectory = path.join(component.directory, 'src');
    await generateTypeDoc({
        entryPoints: [sourceDirectory],
        tsconfig: path.join(component.directory, 'tsconfig.json'),
        out,
        name: `${component.manifest.name} API`,
        exclude: ['**/*.test.ts', '**/*.itest.ts', '**/test/**']
    });
}

const pluginItems = pluginPackages.map(({ slug, manifest }) => ({
    slug,
    label: manifest.name,
    description: manifest.description ?? ''
}));
const toolItems = toolPackages.map(({ manifest }) => ({
    slug: manifest.name,
    label: manifest.name,
    description: manifest.description ?? ''
}));

writePage(
    path.join(apiRoot, 'plugins/index.md'),
    'scripts/generate-api-references.mjs',
    componentIndex('Plugin API reference', pluginItems, '/api/plugins')
);
writePage(
    path.join(apiRoot, 'tools/index.md'),
    'typedoc.json',
    componentIndex('Tool API reference', toolItems, '/api/tools')
);

const actionDirectory = path.join(repoRoot, 'actions');
const actions = fs
    .readdirSync(actionDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .flatMap((entry) => {
        const directory = path.join(actionDirectory, entry.name);
        const yamlFile = ['action.yml', 'action.yaml'].find((name) => fs.existsSync(path.join(directory, name)));
        const sourceDirectory = path.join(directory, 'src');
        if (!yamlFile || !fs.existsSync(sourceDirectory)) return [];
        const file = path.join(directory, yamlFile);
        return [{ slug: entry.name, directory, file, action: parse(fs.readFileSync(file, 'utf8')) }];
    })
    .sort((left, right) => left.slug.localeCompare(right.slug));

for (const { slug, directory, file, action } of actions) {
    const out = path.join(apiRoot, 'actions', slug);
    fs.rmSync(out, { recursive: true, force: true });
    await generateTypeDoc({
        entryPoints: [path.join(directory, 'src')],
        tsconfig: path.join(repoRoot, 'tsconfig.docs.json'),
        out: path.join(out, 'code'),
        name: `${action.name ?? slug} code API`,
        exclude: ['**/*.test.mjs', '**/test/**']
    });
    const page = actionPage(slug, file, action);
    writePage(path.join(out, 'index.md'), page.sourcePath, page.content);
}

writePage(
    path.join(apiRoot, 'actions/index.md'),
    'scripts/generate-api-references.mjs',
    `# Action reference\n\n${actions
        .map(({ slug, action }) => `- [${action.name ?? slug}](/api/actions/${slug}/) — ${action.description ?? ''}`)
        .join('\n')}`
);

const scriptsDirectory = path.join(repoRoot, 'scripts');
await generateTypeDoc({
    entryPoints: [scriptsDirectory],
    tsconfig: path.join(repoRoot, 'tsconfig.docs.json'),
    out: path.join(apiRoot, 'scripts'),
    name: 'Repository script API',
    exclude: ['**/*.test.mjs']
});

writePage(
    path.join(apiRoot, 'index.md'),
    'scripts/generate-api-references.mjs',
    '# Reference\n\nThe generated references below follow the package source, action metadata, and script JSDoc comments.\n\n- [Plugins](/api/plugins/) — plugin implementation APIs\n- [Tools](/api/tools/) — shared libraries and developer tools\n- [Actions](/api/actions/) — action inputs, outputs, and code references\n- [Scripts](/api/scripts/) — repository script APIs'
);

addEditLinks();
