import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const helper = path.join(root, 'scripts', 'market-plugin-name.mjs');
const dirs = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('market-plugin-name', () => {
    it('prints the canonical name exported by the package info module', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-plugin-name-'));
        dirs.push(dir);
        fs.mkdirSync(path.join(dir, 'src'));
        fs.writeFileSync(path.join(dir, 'package.json'), '{}');
        fs.writeFileSync(path.join(dir, 'src', 'info.ts'), "export const info = { name: 'Published plugin' };");

        const result = spawnSync('node', [helper, dir], { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), 'Published plugin');
    });
});
