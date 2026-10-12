import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { cleanWorkspace } from './clean.mjs';

const temporaryRoots = [];

after(() => {
    for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

function createWorkspace() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-clean-'));
    temporaryRoots.push(root);

    for (const file of [
        'build/root-output',
        'packages/example/build/plugin.wasm',
        'tools/example/build/types/bindings/index.d.ts',
        'dist/plugin.wasm',
        '.turbo/cache/task.json',
        '.turbo/metadata.json',
        '.cache/pumpkin/world/level.dat',
        'packages/example/src/plugin.ts'
    ]) {
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'fixture');
    }

    return root;
}

describe('cleanWorkspace', () => {
    it('removes build outputs, root dist and Turbo cache while preserving .cache', () => {
        const root = createWorkspace();

        cleanWorkspace(root);

        for (const directory of ['build', 'packages/example/build', 'tools/example/build', 'dist', '.turbo/cache']) {
            assert.equal(fs.existsSync(path.join(root, directory)), false, `${directory} should be removed`);
        }
        for (const file of [
            '.turbo/metadata.json',
            '.cache/pumpkin/world/level.dat',
            'packages/example/src/plugin.ts'
        ]) {
            assert.equal(fs.existsSync(path.join(root, file)), true, `${file} should be preserved`);
        }
    });

    it('runs through pnpm clean and retains pnpm purge behavior', () => {
        const root = createWorkspace();
        const rootManifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        const scriptDirectory = path.join(root, 'scripts');
        fs.mkdirSync(scriptDirectory, { recursive: true });
        fs.copyFileSync(path.join(import.meta.dirname, 'clean.mjs'), path.join(scriptDirectory, 'clean.mjs'));
        fs.writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify({ name: 'clean-test', private: true, scripts: { clean: rootManifest.scripts.clean } })
        );
        fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n  - "tools/*"\n');

        for (const [directory, name] of [
            ['packages/example', '@test/example-package'],
            ['tools/example', '@test/example-tool']
        ]) {
            const packageRoot = path.join(root, directory);
            fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
            fs.mkdirSync(path.join(packageRoot, 'node_modules'), { recursive: true });
            fs.writeFileSync(path.join(packageRoot, 'node_modules', 'fixture'), 'fixture');
        }
        fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
        fs.writeFileSync(path.join(root, 'node_modules', 'fixture'), 'fixture');

        const result = spawnSync('pnpm', ['clean'], { cwd: root, encoding: 'utf8', timeout: 30_000 });

        assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
        for (const file of [
            'node_modules/fixture',
            'packages/example/node_modules/fixture',
            'tools/example/node_modules/fixture'
        ]) {
            assert.equal(fs.existsSync(path.join(root, file)), false, `${file} should be removed`);
        }
        for (const directory of ['build', 'packages/example/build', 'tools/example/build', 'dist', '.turbo/cache']) {
            assert.equal(fs.existsSync(path.join(root, directory)), false, `${directory} should be removed`);
        }
        assert.equal(fs.existsSync(path.join(root, '.cache/pumpkin/world/level.dat')), true);
        assert.equal(fs.existsSync(path.join(root, '.turbo/metadata.json')), true);
    });
});
