// Tests Market metadata generation from plugin info modules.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const helper = path.join(root, 'scripts', 'market-plugin-metadata.mjs');
const dirs = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function plugin(info, extra = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-plugin-metadata-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(extra.package ?? {}));
    fs.writeFileSync(path.join(dir, 'src', 'info.ts'), `export const info = ${JSON.stringify(info)};`);
    return dir;
}

function run(dir) {
    return spawnSync('node', [helper, dir], { cwd: root, encoding: 'utf8' });
}

describe('market-plugin-metadata', () => {
    it('generates localized listing descriptions and ordered command entries', () => {
        const dir = plugin({
            name: 'ExamplePlugin',
            description: 'An example listing',
            commands: [
                { usage: '/example', description: 'Show information', permission: 'ExamplePlugin:command.example' },
                { usage: '/example reload', description: 'Reload the plugin' },
            ],
        });

        const result = run(dir);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
            translatedDescriptions: { 'en-US': 'An example listing' },
            commands: [
                {
                    name: 'example',
                    permission: 'ExamplePlugin:command.example',
                    description: { 'en-US': 'Show information' },
                    display_order: 0,
                },
                { name: 'example reload', description: { 'en-US': 'Reload the plugin' }, display_order: 1 },
            ],
        });
    });

    it('adds README content without its installation or commands sections', () => {
        const dir = plugin({
            name: 'ExamplePlugin',
            description: 'A short listing summary',
            commands: [],
        });
        fs.writeFileSync(
            path.join(dir, 'README.md'),
            `# ExamplePlugin

<!-- docs:begin summary -->
A short listing summary
<!-- docs:end summary -->

## Installation

This GitHub release installation text does not belong in the Market description.

## Commands

This command list is uploaded separately.

## Features

Players can share named locations and control who can see each one.
`,
        );

        const result = run(dir);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(
            JSON.parse(result.stdout).translatedDescriptions['en-US'],
            'A short listing summary\n\n## Features\n\nPlayers can share named locations and control who can see each one.',
        );
    });

    it('links README paths to the release tag on GitHub', () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'market-plugin-metadata-'));
        dirs.push(repo);
        const dir = path.join(repo, 'packages', 'example');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
            path.join(repo, 'release-please-config.json'),
            JSON.stringify({ packages: { 'packages/example': { component: 'example' } } }),
        );
        fs.writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({
                version: '1.2.3',
                repository: {
                    type: 'git',
                    url: 'git+https://github.com/example/plugins.git',
                    directory: 'packages/example',
                },
            }),
        );
        fs.writeFileSync(
            path.join(dir, 'src', 'info.ts'),
            "export const info = { name: 'ExamplePlugin', description: 'Summary', commands: [] };",
        );
        fs.writeFileSync(
            path.join(dir, 'README.md'),
            `# ExamplePlugin

## Guide

Read the [guide](docs/index.md "Guide"), the [terrain library](../../tools/terrain/README.md),
the [command list](#commands) and the [website](https://example.org/).

![Screenshot](docs/screenshot.png)

\`\`\`md
[unchanged](docs/example.md)
\`\`\`
`,
        );

        const result = run(dir);
        assert.equal(result.status, 0, result.stderr);
        const description = JSON.parse(result.stdout).translatedDescriptions['en-US'];
        const tag = 'https://github.com/example/plugins/blob/example-v1.2.3';
        assert.ok(description.includes(`[guide](${tag}/packages/example/docs/index.md "Guide")`), description);
        assert.ok(description.includes(`[terrain library](${tag}/tools/terrain/README.md)`), description);
        assert.ok(description.includes(`[command list](${tag}/packages/example/README.md#commands)`), description);
        assert.ok(description.includes('[website](https://example.org/)'), description);
        assert.ok(
            description.includes(
                '![Screenshot](https://github.com/example/plugins/raw/example-v1.2.3/packages/example/docs/screenshot.png)',
            ),
            description,
        );
        assert.ok(description.includes('[unchanged](docs/example.md)'), description);
    });

    it('supports a custom info path and a plugin with no commands', () => {
        const dir = plugin(
            { name: 'ExamplePlugin', description: 'No command listing', commands: [] },
            { package: { pumpkinPlugin: { info: 'src/market-info.ts' } } },
        );
        fs.writeFileSync(
            path.join(dir, 'src', 'market-info.ts'),
            "export default { name: 'ExamplePlugin', description: 'No command listing', commands: [] };",
        );

        const result = run(dir);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
            translatedDescriptions: { 'en-US': 'No command listing' },
            commands: [],
        });
    });

    it('fails clearly when the info module has no description', () => {
        const dir = plugin({ name: 'BrokenPlugin' });
        const result = run(dir);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /must export plugin info with a description/);
    });
});
