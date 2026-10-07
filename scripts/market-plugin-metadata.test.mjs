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
                { usage: '/example reload', description: 'Reload the plugin' }
            ]
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
                    display_order: 0
                },
                { name: 'example reload', description: { 'en-US': 'Reload the plugin' }, display_order: 1 }
            ]
        });
    });

    it('supports a custom info path and a plugin with no commands', () => {
        const dir = plugin(
            { description: 'No command listing', commands: [] },
            { package: { pumpkinPlugin: { info: 'src/market-info.ts' } } }
        );
        fs.writeFileSync(
            path.join(dir, 'src', 'market-info.ts'),
            "export default { description: 'No command listing', commands: [] };"
        );

        const result = run(dir);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
            translatedDescriptions: { 'en-US': 'No command listing' },
            commands: []
        });
    });

    it('fails clearly when the info module has no description', () => {
        const dir = plugin({ name: 'BrokenPlugin' });
        const result = run(dir);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /must export plugin info with a description/);
    });
});
