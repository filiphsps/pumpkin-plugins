import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PlopTypes } from '@turbo/gen';
import { parse } from 'yaml';

const KEBAB_CASE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;
// Same limit as scripts/package-metadata.mjs, which checks every package.json.
const MAX_DESCRIPTION = 70;

type Answers = { name: string; displayName: string; description: string; turbo: { paths: { root: string } } };

type Group = 'packages' | 'actions' | 'extensions';

// Prompts for a new kebab-case folder in `group`. turbo gen runs from the repository root.
function folderPrompt(group: Group, example: string) {
    return {
        type: 'input',
        name: 'name',
        message: `Folder name (kebab-case, e.g. ${example}):`,
        validate: (value: string) => {
            if (!KEBAB_CASE.test(value)) return 'Use kebab-case: lowercase letters, digits and dashes';
            if (fs.existsSync(path.join(process.cwd(), group, value))) return `${group}/${value} already exists`;
            return true;
        },
    };
}

// `my-action` becomes `My Action`.
function titleCase(name: string): string {
    return name
        .split('-')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

// Every template in templates/<group>, without its .hbs suffix, so a new template can't be left out.
function templateFiles(plop: PlopTypes.NodePlopAPI, group: string): string[] {
    const dir = path.join(plop.getPlopfilePath(), 'templates', group);
    return fs
        .readdirSync(dir, { encoding: 'utf8', recursive: true })
        .filter((file) => file.endsWith('.hbs'))
        .map((file) => file.slice(0, -'.hbs'.length).replaceAll(path.sep, '/'));
}

function modifyJson(file: string, update: (json: Record<string, unknown>, name: string) => Record<string, unknown>) {
    return {
        type: 'modify',
        path: `{{ turbo.paths.root }}/${file}`,
        transform: (content: string, data: Answers) =>
            `${JSON.stringify(update(JSON.parse(content), data.name), null, 4)}\n`,
    };
}

// Registers the component in both Release Please files, pinning its first release to 0.0.1.
// check-release-config.mjs fails when a component is missing from either file, unless
// release-please-paused.json lists it.
function registerComponent(group: Group, entry: Record<string, unknown> = {}) {
    const sorted = (json: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(json).sort(([a], [b]) => a.localeCompare(b)));
    return [
        modifyJson('release-please-config.json', (config, name) => ({
            ...config,
            packages: sorted({
                ...(config.packages as Record<string, unknown>),
                [`${group}/${name}`]: { component: name, ...entry, 'release-as': '0.0.1' },
            }),
        })),
        modifyJson('.release-please-manifest.json', (manifest, name) =>
            sorted({ ...manifest, [`${group}/${name}`]: '0.0.0' }),
        ),
    ];
}

function run(root: string, command: string, args: string[], done: string) {
    // On Windows pnpm is usually pnpm.cmd, which only starts through a shell.
    execFileSync(command, args, {
        cwd: root,
        stdio: 'inherit',
        shell: process.platform === 'win32' && command === 'pnpm',
    });
    return done;
}

// Owner fields that package-metadata.mjs doesn't derive are copied from the root package.json.
function readRootPackage(root: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
}

// Fills in homepage, bugs, repository and license from the root package.json.
function fillPackageMetadata(root: string) {
    return () =>
        run(root, process.execPath, ['scripts/package-metadata.mjs', '--fix'], 'Filled in the package metadata');
}

// vsce refuses to package an extension whose engines.vscode is older than @types/vscode.
function catalogVersion(root: string, dependency: string): string {
    const workspace = parse(fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'));
    return String(workspace.catalog[dependency]);
}

/** Defines Turbo generators for plugins, actions, and extensions. */
export default function generator(plop: PlopTypes.NodePlopAPI): void {
    plop.setHelper('json', (value: unknown) => JSON.stringify(value));
    plop.setHelper('helloWorld', (displayName: string) => JSON.stringify(`Hello World from ${displayName}`));

    plop.setGenerator('plugin', {
        description: 'Create a new Pumpkin plugin package in packages/',
        prompts: [
            folderPrompt('packages', 'my-plugin'),
            {
                type: 'input',
                name: 'displayName',
                message: 'Plugin name as Pumpkin shows it (PascalCase, e.g. MyPlugin):',
                default: (answers: { name: string }) => plop.getHelper('pascalCase')(answers.name),
                validate: (value: string) => PASCAL_CASE.test(value) || 'Use PascalCase letters and digits only',
            },
            {
                type: 'input',
                name: 'description',
                message: `One-line description (at most ${MAX_DESCRIPTION} characters; the README can say more):`,
                validate: (value: string) => {
                    if (value.trim().length === 0) return 'A description is required';
                    if (/[\r\n]/.test(value)) return 'Enter a one-line description';
                    return value.length <= MAX_DESCRIPTION || `Use at most ${MAX_DESCRIPTION} characters`;
                },
            },
        ],
        actions: (data) => {
            const { turbo } = data as Answers;
            const root = turbo.paths.root;
            const name = (data as Answers).name;
            const rootPackage = readRootPackage(root);
            return [
                ...templateFiles(plop, 'plugin').map((file) => ({
                    type: 'add',
                    path: `{{ turbo.paths.root }}/packages/{{ name }}/${file}`,
                    templateFile: `templates/plugin/${file}.hbs`,
                    data: { rootPackage },
                })),
                ...registerComponent('packages'),
                fillPackageMetadata(root),
                () => run(root, 'pnpm', ['install', '--no-frozen-lockfile'], 'Installed dependencies'),
                () =>
                    run(
                        root,
                        'pnpm',
                        ['--filter', `./packages/${name}`, 'run', 'readme'],
                        'Generated the plugin README',
                    ),
                () =>
                    run(
                        root,
                        'pnpm',
                        ['exec', 'pumpkin-plugins-docs', 'root'],
                        'Updated the package list in README.md',
                    ),
                () =>
                    run(
                        root,
                        'pnpm',
                        [
                            'exec',
                            'biome',
                            'check',
                            '--write',
                            `packages/${name}`,
                            'release-please-config.json',
                            '.release-please-manifest.json',
                        ],
                        'Formatted the new files',
                    ),
            ];
        },
    });

    plop.setGenerator('action', {
        description: 'Create a new GitHub Action in actions/',
        prompts: [
            folderPrompt('actions', 'my-action'),
            {
                type: 'input',
                name: 'displayName',
                message: 'Action name shown in GitHub (e.g. My Action):',
                default: (answers: { name: string }) => titleCase(answers.name),
                validate: (value: string) => {
                    if (!value.trim()) return 'An action name is required';
                    return !/[\r\n]/.test(value) || 'Enter a one-line action name';
                },
            },
            {
                type: 'input',
                name: 'description',
                message: 'One-line description:',
                validate: (value: string) => {
                    if (!value.trim()) return 'A description is required';
                    return !/[\r\n]/.test(value) || 'Enter a one-line description';
                },
            },
        ],
        actions: (data) => {
            const answers = data as Answers;
            const root = answers.turbo.paths.root;
            const name = answers.name;
            // package.json allows "Name <email> (url)" or an object; action.yml wants only the name.
            const author = readRootPackage(root).author as string | { name: string };
            const authorName = (typeof author === 'string' ? author : author.name).replace(/\s*[<(].*$/, '');
            return [
                ...templateFiles(plop, 'action').map((file) => ({
                    type: 'add',
                    path: `{{ turbo.paths.root }}/actions/{{ name }}/${file}`,
                    templateFile: `templates/action/${file}.hbs`,
                    data: { authorName },
                })),
                ...registerComponent('actions', { 'release-type': 'simple' }),
                () =>
                    run(
                        root,
                        'pnpm',
                        ['exec', 'pumpkin-plugins-docs', 'actions'],
                        'Generated action README input/output tables',
                    ),
                () =>
                    run(
                        root,
                        'pnpm',
                        ['exec', 'pumpkin-plugins-docs', 'root'],
                        'Updated the actions table in README.md',
                    ),
                () =>
                    run(
                        root,
                        'pnpm',
                        [
                            'exec',
                            'biome',
                            'check',
                            '--write',
                            `actions/${name}`,
                            'release-please-config.json',
                            '.release-please-manifest.json',
                        ],
                        'Formatted the new action',
                    ),
            ];
        },
    });

    plop.setGenerator('extension', {
        description: 'Create a VS Code extension in extensions/',
        prompts: [
            folderPrompt('extensions', 'my-extension'),
            {
                type: 'input',
                name: 'displayName',
                message: 'Extension display name:',
                default: (answers: { name: string }) => titleCase(answers.name),
                validate: (value: string) => {
                    if (!value.trim()) return 'An extension name is required';
                    return !/[\r\n]/.test(value) || 'Enter a one-line extension name';
                },
            },
            {
                type: 'input',
                name: 'description',
                message: `One-line description (at most ${MAX_DESCRIPTION} characters):`,
                validate: (value: string) => {
                    if (!value.trim()) return 'A description is required';
                    if (value.length > MAX_DESCRIPTION) return `Use at most ${MAX_DESCRIPTION} characters`;
                    return !/[\r\n]/.test(value) || 'Enter a one-line description';
                },
            },
        ],
        actions: (data) => {
            const answers = data as Answers;
            const root = answers.turbo.paths.root;
            const name = answers.name;
            const vscodeVersion = catalogVersion(root, '@types/vscode');
            const rootPackage = readRootPackage(root);
            return [
                ...templateFiles(plop, 'extension').map((file) => ({
                    type: 'add',
                    path: `{{ turbo.paths.root }}/extensions/{{ name }}/${file}`,
                    templateFile: `templates/extension/${file}.hbs`,
                    data: { rootPackage, vscodeVersion },
                })),
                // vsce wants a license file in the extension; it carries the repository's license.
                {
                    type: 'add',
                    path: '{{ turbo.paths.root }}/extensions/{{ name }}/LICENSE',
                    templateFile: path.join(root, 'LICENSE'),
                },
                ...registerComponent('extensions'),
                fillPackageMetadata(root),
                () => run(root, 'pnpm', ['install', '--no-frozen-lockfile'], 'Installed dependencies'),
                () => run(root, 'pnpm', ['exec', 'pumpkin-plugins-docs', 'root'], 'Updated root README and references'),
                () =>
                    run(
                        root,
                        'pnpm',
                        [
                            'exec',
                            'biome',
                            'check',
                            '--write',
                            `extensions/${name}`,
                            'release-please-config.json',
                            '.release-please-manifest.json',
                        ],
                        'Formatted the extension and release registration',
                    ),
            ];
        },
    });
}
