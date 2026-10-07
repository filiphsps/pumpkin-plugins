import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PlopTypes } from '@turbo/gen';

const KEBAB_CASE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;
// Same limit as scripts/package-metadata.mjs, which checks every package.json.
const MAX_DESCRIPTION = 70;
const ACTION_FILES = ['README.md', 'CHANGELOG.md', 'version.txt', 'action.yml', 'src/index.mjs', 'src/index.test.mjs'];

const FILES = [
    'README.md',
    'package.json',
    'tsconfig.json',
    'vitest.config.ts',
    'src/name.ts',
    'src/info.ts',
    'src/plugin.ts',
    'test/plugin.itest.ts'
];

type Answers = { name: string; displayName: string; description: string; turbo: { paths: { root: string } } };

// Both release-please files list every plugin; CI fails if one is missing.
function registerRelease(file: string, update: (json: Record<string, unknown>, name: string) => void) {
    return {
        type: 'modify',
        path: `{{ turbo.paths.root }}/${file}`,
        transform: (content: string, data: Answers) => {
            const json = JSON.parse(content);
            update(json, data.name);
            return `${JSON.stringify(json, null, 4)}\n`;
        }
    };
}

function run(root: string, command: string, args: string[], done: string) {
    execFileSync(command, args, { cwd: root, stdio: 'inherit' });
    return done;
}

function sortReleaseEntries(entries: [string, unknown][]): [string, unknown][] {
    return entries.sort(([a], [b]) => {
        const groupA = a.startsWith('actions/') ? 1 : 0;
        const groupB = b.startsWith('actions/') ? 1 : 0;
        return groupA - groupB || a.localeCompare(b);
    });
}

/** Defines the `plugin` generator that scaffolds a new plugin package. Run it with `pnpm gen`. */
export default function generator(plop: PlopTypes.NodePlopAPI): void {
    plop.setHelper('json', (value: string) => JSON.stringify(value));

    plop.setGenerator('plugin', {
        description: 'Create a new Pumpkin plugin package in packages/',
        prompts: [
            {
                type: 'input',
                name: 'name',
                message: 'Folder name (kebab-case, e.g. my-plugin):',
                validate: (value: string) => {
                    if (!KEBAB_CASE.test(value)) return 'Use kebab-case: lowercase letters, digits and dashes';
                    if (fs.existsSync(path.join(process.cwd(), 'packages', value)))
                        return `packages/${value} already exists`;
                    return true;
                }
            },
            {
                type: 'input',
                name: 'displayName',
                message: 'Plugin name as Pumpkin shows it (PascalCase, e.g. MyPlugin):',
                default: (answers: { name: string }) => plop.getHelper('pascalCase')(answers.name),
                validate: (value: string) => PASCAL_CASE.test(value) || 'Use PascalCase letters and digits only'
            },
            {
                type: 'input',
                name: 'description',
                message: `One-line description (at most ${MAX_DESCRIPTION} characters; the README can say more):`,
                validate: (value: string) => {
                    if (value.trim().length === 0) return 'A description is required';
                    return value.length <= MAX_DESCRIPTION || `Keep it under ${MAX_DESCRIPTION} characters`;
                }
            }
        ],
        actions: (data) => {
            const { turbo } = data as Answers;
            const root = turbo.paths.root;
            const name = (data as Answers).name;
            return [
                ...FILES.map((file) => ({
                    type: 'add',
                    path: `{{ turbo.paths.root }}/packages/{{ name }}/${file}`,
                    templateFile: `templates/plugin/${file}.hbs`
                })),
                registerRelease('release-please-config.json', (json, name) => {
                    const packages = json.packages as Record<string, unknown>;
                    packages[`packages/${name}`] = { component: name, 'release-as': '0.0.1' };
                    json.packages = Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b)));
                }),
                registerRelease('.release-please-manifest.json', (json, name) => {
                    json[`packages/${name}`] = '0.0.0';
                    const sorted = Object.entries(json).sort(([a], [b]) => a.localeCompare(b));
                    for (const key of Object.keys(json)) delete json[key];
                    Object.assign(json, Object.fromEntries(sorted));
                }),
                () => run(root, 'pnpm', ['install', '--no-frozen-lockfile'], 'Installed dependencies'),
                () =>
                    run(
                        root,
                        'pnpm',
                        ['--filter', `./packages/${name}`, 'run', 'readme'],
                        'Generated the plugin README'
                    ),
                () =>
                    run(
                        root,
                        'pnpm',
                        ['exec', 'pumpkin-plugins-docs', 'root'],
                        'Updated the package list in README.md'
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
                            '.release-please-manifest.json'
                        ],
                        'Formatted the new files'
                    )
            ];
        }
    });

    plop.setGenerator('action', {
        description: 'Create a new GitHub Action in actions/',
        prompts: [
            {
                type: 'input',
                name: 'name',
                message: 'Folder name (kebab-case, e.g. my-action):',
                validate: (value: string) => {
                    if (!KEBAB_CASE.test(value)) return 'Use kebab-case: lowercase letters, digits and dashes';
                    if (fs.existsSync(path.join(process.cwd(), 'actions', value)))
                        return `actions/${value} already exists`;
                    return true;
                }
            },
            {
                type: 'input',
                name: 'displayName',
                message: 'Action name shown in GitHub (e.g. My Action):',
                default: (answers: { name: string }) =>
                    answers.name
                        .split('-')
                        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
                        .join(' '),
                validate: (value: string) => {
                    if (!value.trim()) return 'An action name is required';
                    return !/[\r\n]/.test(value) || 'Enter a one-line action name';
                }
            },
            {
                type: 'input',
                name: 'description',
                message: 'One-line description:',
                validate: (value: string) => {
                    if (!value.trim()) return 'A description is required';
                    return !/[\r\n]/.test(value) || 'Enter a one-line description';
                }
            }
        ],
        actions: (data) => {
            const answers = data as Answers;
            const root = answers.turbo.paths.root;
            const name = answers.name;
            return [
                ...ACTION_FILES.map((file) => ({
                    type: 'add',
                    path: `{{ turbo.paths.root }}/actions/{{ name }}/${file}`,
                    templateFile: `templates/action/${file}.hbs`
                })),
                registerRelease('release-please-config.json', (json, name) => {
                    const packages = json.packages as Record<string, unknown>;
                    packages[`actions/${name}`] = {
                        component: name,
                        'release-type': 'simple',
                        'release-as': '0.0.1'
                    };
                    json.packages = Object.fromEntries(sortReleaseEntries(Object.entries(packages)));
                }),
                registerRelease('.release-please-manifest.json', (json, name) => {
                    json[`actions/${name}`] = '0.0.0';
                    const sorted = sortReleaseEntries(Object.entries(json));
                    for (const key of Object.keys(json)) delete json[key];
                    Object.assign(json, Object.fromEntries(sorted));
                }),
                () =>
                    run(
                        root,
                        'node',
                        ['scripts/sync-action-readmes.mjs'],
                        'Generated action README input/output tables'
                    ),
                () =>
                    run(
                        root,
                        'pnpm',
                        ['exec', 'pumpkin-plugins-docs', 'root'],
                        'Updated the actions table in README.md'
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
                            '.release-please-manifest.json'
                        ],
                        'Formatted the new action'
                    )
            ];
        }
    });
}
