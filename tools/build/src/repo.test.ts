import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cacheDir, findRepoRoot } from './repo.ts';

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.PUMPKIN_PLUGINS_CACHE_DIR;
});

function workspace(): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-')));
    dirs.push(root);
    fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    fs.mkdirSync(path.join(root, 'packages/a/src'), { recursive: true });
    return root;
}

describe('findRepoRoot', () => {
    it('finds the workspace root from any folder inside it', () => {
        const root = workspace();
        expect(findRepoRoot(path.join(root, 'packages/a/src'))).toBe(root);
        expect(findRepoRoot(root)).toBe(root);
    });

    it('falls back to the folder itself outside a workspace', () => {
        const lone = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lone-')));
        dirs.push(lone);
        expect(findRepoRoot(lone)).toBe(lone);
    });
});

describe('cacheDir', () => {
    it('is .cache in the repository root unless overridden', () => {
        const root = workspace();
        expect(cacheDir(path.join(root, 'packages/a'))).toBe(path.join(root, '.cache'));
        process.env.PUMPKIN_PLUGINS_CACHE_DIR = '/somewhere/else';
        expect(cacheDir(path.join(root, 'packages/a'))).toBe('/somewhere/else');
        process.env.PUMPKIN_PLUGINS_CACHE_DIR = '';
        expect(cacheDir(path.join(root, 'packages/a'))).toBe(path.join(root, '.cache'));
    });
});
