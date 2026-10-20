import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LatestVersionOptions } from '@badisi/latest-version';
import { parse } from 'jsonc-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodemodDefinition } from './types.js';
import { runUpdateBuild } from './update-build.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
    );
});

async function createProject(source: string): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pumpkin-update-build-'));
    temporaryDirectories.push(directory);
    await fs.writeFile(path.join(directory, 'package.json'), source);
    return directory;
}

function lookup(latest: string, overrides: Record<string, unknown> = {}) {
    return vi.fn(async (_packageName: string, _options?: LatestVersionOptions) => ({
        name: '@pumpkin-plugins/build',
        latest,
        updatesAvailable: false as const,
        ...overrides,
    }));
}

const resolveInstalledVersion = () => '0.1.0';

/** Reads the builder range from each dependency section, in declaration order. */
function builderRanges(source: string | undefined): unknown[] {
    const manifest = parse(source ?? '') as Record<string, Record<string, unknown> | undefined>;
    return Object.values(manifest)
        .map((section) => section?.['@pumpkin-plugins/build'])
        .filter((range) => range !== undefined);
}

describe('update-build workflow', () => {
    it('does a fresh bounded registry lookup and previews the latest package range by default', async () => {
        const root = await createProject('{\n    "dependencies": { "@pumpkin-plugins/build": "^0.1.0" }\n}\n');
        const registryLookup = lookup('0.2.0');

        const report = await runUpdateBuild([], {
            cwd: root,
            lookup: registryLookup,
            resolveInstalledVersion,
        });

        expect(registryLookup.mock.calls[0]?.[1]?.useCache).toBeUndefined();
        expect(registryLookup.mock.calls[0]?.[1]?.requestOptions?.timeout).toBeGreaterThan(0);
        expect(report.changedFiles).toHaveLength(1);
        expect(builderRanges(await fs.readFile(path.join(root, 'package.json'), 'utf8'))).toEqual(['^0.1.0']);
        expect(builderRanges(report.changedFiles[0]?.after)).toEqual(['^0.2.0']);
    });

    it('does not change an already-current project', async () => {
        const source = '{\n    "dependencies": { "@pumpkin-plugins/build": "^0.2.0" }\n}\n';
        const root = await createProject(source);

        const report = await runUpdateBuild([], {
            cwd: root,
            lookup: lookup('0.2.0'),
            resolveInstalledVersion: () => '0.2.0',
        });

        expect(report.changedFiles).toEqual([]);
        expect(await fs.readFile(path.join(root, 'package.json'), 'utf8')).toBe(source);
    });

    it('fails before scanning files when installed builder dependencies are missing', async () => {
        const root = await createProject('{"dependencies":{"@pumpkin-plugins/build":"^0.1.0"}}');
        const registryLookup = lookup('0.2.0');

        await expect(
            runUpdateBuild([], { cwd: root, lookup: registryLookup, resolveInstalledVersion: () => undefined }),
        ).rejects.toThrow(/install.*dependencies/i);
        expect(registryLookup).not.toHaveBeenCalled();
    });

    it('rejects a registry failure before the runner can write files', async () => {
        const source = '{"dependencies":{"@pumpkin-plugins/build":"^0.1.0"}}';
        const root = await createProject(source);
        const registryLookup = vi.fn(async (_packageName: string, _options?: LatestVersionOptions) => ({
            name: '@pumpkin-plugins/build',
            error: new Error('registry unavailable'),
            updatesAvailable: false as const,
        }));

        await expect(
            runUpdateBuild([], { cwd: root, lookup: registryLookup, resolveInstalledVersion }),
        ).rejects.toThrow(/registry unavailable/i);
        expect(await fs.readFile(path.join(root, 'package.json'), 'utf8')).toBe(source);
    });

    it('rejects an npm latest version older than the installed builder before writes', async () => {
        const source = '{"dependencies":{"@pumpkin-plugins/build":"^0.2.0"}}';
        const root = await createProject(source);

        await expect(
            runUpdateBuild([], {
                cwd: root,
                lookup: lookup('0.1.0'),
                resolveInstalledVersion: () => '0.2.0',
            }),
        ).rejects.toThrow(/older than the installed/i);
        expect(await fs.readFile(path.join(root, 'package.json'), 'utf8')).toBe(source);
    });

    it('preserves exact, caret, and tilde range styles across dependency sections', async () => {
        const source = [
            '{',
            '    "dependencies": { "@pumpkin-plugins/build": "0.1.0" },',
            '    "devDependencies": { "@pumpkin-plugins/build": "^0.1.0" },',
            '    "optionalDependencies": { "@pumpkin-plugins/build": "~0.1.0" },',
            '    "peerDependencies": { "@pumpkin-plugins/build": "^0.1.0" }',
            '}',
            '',
        ].join('\n');
        const root = await createProject(source);

        const report = await runUpdateBuild([], {
            cwd: root,
            lookup: lookup('0.2.0'),
            resolveInstalledVersion,
        });

        expect(builderRanges(report.changedFiles[0]?.after)).toEqual(['0.2.0', '^0.2.0', '~0.2.0', '^0.2.0']);
    });

    it.each([
        ['catalog:build'],
        ['workspace:*'],
        ['npm:@other/build@0.1.0'],
        ['https://example.invalid/build.tgz'],
        ['file:../build'],
        ['git+https://example.invalid/build.git'],
        ['^0.1.0 || ^0.2.0'],
    ])('leaves unsupported declaration %s unchanged with a manual note', async (specification) => {
        const source = JSON.stringify({ dependencies: { '@pumpkin-plugins/build': specification } }, null, 4);
        const root = await createProject(source);

        const report = await runUpdateBuild([], {
            cwd: root,
            lookup: lookup('0.2.0'),
            resolveInstalledVersion,
        });

        expect(report.changedFiles).toEqual([]);
        expect(report.messages).toEqual(
            expect.arrayContaining([expect.objectContaining({ text: expect.stringMatching(/manually/) })]),
        );
        expect(await fs.readFile(path.join(root, 'package.json'), 'utf8')).toBe(source);
    });

    it('escapes terminal control characters in unsupported dependency notes', async () => {
        const specification = '\u001b[31m\u009bfile:../build';
        const source = JSON.stringify({ dependencies: { '@pumpkin-plugins/build': specification } }, null, 4);
        const root = await createProject(source);

        const report = await runUpdateBuild([], {
            cwd: root,
            lookup: lookup('0.2.0'),
            resolveInstalledVersion,
        });

        const note = report.messages[0]?.text ?? '';
        expect(note).toContain('\\u009b');
        expect(note).not.toContain(String.fromCharCode(0x1b));
        expect(note).not.toContain(String.fromCharCode(0x9b));
    });

    it('preserves JSONC comments and formatting while updating supported declarations', async () => {
        const source = [
            '{',
            '    // Keep this note with the dependency.',
            '    "dependencies": {',
            '        "@pumpkin-plugins/build": "^0.1.0"',
            '    }',
            '}',
            '',
        ].join('\n');
        const root = await createProject(source);

        const report = await runUpdateBuild([], {
            cwd: root,
            lookup: lookup('0.2.0'),
            resolveInstalledVersion,
        });

        expect(report.changedFiles[0]?.after).toContain('// Keep this note with the dependency.');
        expect(builderRanges(report.changedFiles[0]?.after)).toEqual(['^0.2.0']);
    });

    it('does not add a builder dependency when the package has none', async () => {
        const source = '{\n    "name": "consumer"\n}\n';
        const root = await createProject(source);

        const report = await runUpdateBuild([], {
            cwd: root,
            lookup: lookup('0.2.0'),
            resolveInstalledVersion,
        });

        expect(report.changedFiles).toEqual([]);
        expect(await fs.readFile(path.join(root, 'package.json'), 'utf8')).toBe(source);
    });

    it('selects release migrations from the builder installed for each scanned package', async () => {
        const root = await createProject('{"name":"workspace"}');
        const plugin = path.join(root, 'plugin');
        await fs.mkdir(plugin);
        await fs.writeFile(path.join(plugin, 'package.json'), '{"dependencies":{"@pumpkin-plugins/build":"^0.1.0"}}');
        await fs.writeFile(path.join(plugin, 'plugin.txt'), 'old\n');
        const installed = new Map([
            [root, '0.2.0'],
            [plugin, '0.1.0'],
        ]);

        const report = await runUpdateBuild(['plugin'], {
            cwd: root,
            lookup: lookup('0.2.0'),
            resolveInstalledVersion: (directory) => installed.get(directory),
            migrations: [
                {
                    introducedIn: '0.2.0',
                    codemod: {
                        id: 'rename',
                        description: 'rename',
                        matchesFile: (relativePath) => relativePath.endsWith('.txt'),
                        transform: ({ source }) => ({ source: source.replace('old', 'new') }),
                    },
                },
            ],
        });

        expect(report.changedFiles.find(({ relativePath }) => relativePath === 'plugin/plugin.txt')?.after).toBe(
            'new\n',
        );
    });

    it('notes a missing builder dependency once for the whole run', async () => {
        const root = await createProject('{"name":"consumer"}');
        await fs.mkdir(path.join(root, 'fixture'));
        await fs.writeFile(path.join(root, 'fixture/package.json'), '{"name":"fixture"}');

        const report = await runUpdateBuild([], { cwd: root, lookup: lookup('0.2.0'), resolveInstalledVersion });

        expect(report.messages.filter(({ text }) => text.includes('No direct'))).toHaveLength(1);
    });

    it('does not note a missing builder when another scanned package declares it', async () => {
        const root = await createProject('{"dependencies":{"@pumpkin-plugins/build":"^0.1.0"}}');
        await fs.mkdir(path.join(root, 'fixture'));
        await fs.writeFile(path.join(root, 'fixture/package.json'), '{"name":"fixture"}');

        const report = await runUpdateBuild([], { cwd: root, lookup: lookup('0.2.0'), resolveInstalledVersion });

        expect(report.messages.filter(({ text }) => text.includes('No direct'))).toEqual([]);
    });

    it('runs selected release migrations in semver order only inside the version interval', async () => {
        const root = await createProject('{"dependencies":{"@pumpkin-plugins/build":"^0.1.0"}}');
        await fs.writeFile(path.join(root, 'plugin.txt'), 'start\n');
        const migration = (
            id: string,
            introducedIn: string,
            from: string,
            to: string,
        ): {
            introducedIn: string;
            codemod: CodemodDefinition;
        } => ({
            introducedIn,
            codemod: {
                id,
                description: id,
                matchesFile: (relativePath) => relativePath.endsWith('.txt'),
                transform: ({ source }) => ({ source: source.replace(from, to) }),
            },
        });

        const report = await runUpdateBuild([], {
            cwd: root,
            lookup: lookup('0.4.0'),
            resolveInstalledVersion,
            migrations: [
                migration('later', '0.3.0', 'middle', 'end'),
                migration('outside', '0.5.0', 'start', 'outside'),
                migration('first', '0.2.0', 'start', 'middle'),
                migration('already-installed', '0.1.0', 'start', 'old'),
            ],
        });

        expect(report.changedFiles.find(({ relativePath }) => relativePath === 'plugin.txt')?.after).toBe('end\n');
    });

    it('is repeatable when version and migration transforms already ran', async () => {
        const root = await createProject('{"dependencies":{"@pumpkin-plugins/build":"^0.1.0"}}');
        await fs.writeFile(path.join(root, 'plugin.txt'), 'old\n');
        const migrations = [
            {
                introducedIn: '0.2.0',
                codemod: {
                    id: 'idempotent',
                    description: 'idempotent test',
                    matchesFile: (relativePath: string) => relativePath.endsWith('.txt'),
                    transform: ({ source }: { source: string }) => ({ source: source.replace('old', 'new') }),
                },
            },
        ];
        const options = {
            cwd: root,
            lookup: lookup('0.2.0'),
            resolveInstalledVersion,
            migrations,
            write: true,
        };

        await runUpdateBuild([], options);
        const secondRun = await runUpdateBuild([], options);

        expect(secondRun.changedFiles).toEqual([]);
        expect(await fs.readFile(path.join(root, 'plugin.txt'), 'utf8')).toBe('new\n');
    });
});
